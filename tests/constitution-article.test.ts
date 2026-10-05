import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

import project from "../templates/project.example.json" with { type: "json" };
import { compileSchemas } from "../src/validation/schemas.ts";

const ROOT = join(import.meta.dir, "..");
const REGISTRY = join(import.meta.dir, "fixtures", "constitution", "registry");
const schemas = compileSchemas(ROOT);
const validateArticle = schemas.validatorFor("constitution-article");
const validateProject = schemas.validatorFor("project");
if (validateArticle === undefined || validateProject === undefined)
  throw new Error("constitution schemas did not compile");

interface Obligation {
  id: string;
}
interface Article {
  id: string;
  source: { document: string; section: string; quote: string };
  do?: Obligation[];
  dont?: Obligation[];
  exceptions?: Array<{ source?: Article["source"] }>;
  related?: { conflicts?: string[]; tie_breakers?: Array<{ prevails_over: string }>; supersedes?: string[] };
  enforced_by?: Array<{ covers: string }>;
}

const files = readdirSync(join(REGISTRY, "articles")).toSorted();
const parsed = files.map((file) => {
  const value: unknown = parseYaml(readFileSync(join(REGISTRY, "articles", file), "utf8"));
  return { file, value };
});
// The schema is the parser: an article that fails it is dropped here, so the
// file-name test below fails on it as well as the schema test naming it.
function isArticle(value: unknown): value is Article {
  return validateArticle?.(value) === true;
}
const articles = parsed.flatMap((p) => (isArticle(p.value) ? [p.value] : []));
const ids = new Set(articles.map((a) => a.id));

/** The lines under each `## ` heading of a source document, keyed by heading text. */
function sections(document: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of readFileSync(join(REGISTRY, document), "utf8").split("\n")) {
    if (line.startsWith("## ")) {
      current = [];
      out.set(line.slice(3), current);
    } else current?.push(line);
  }
  return out;
}

describe("the invented fixture registry", () => {
  test.each(parsed.map((p) => [p.file, p.value] as const))(
    "%s validates against the article schema",
    (_file, value) => {
      expect({ valid: validateArticle(value), errors: validateArticle.errors ?? null }).toEqual({
        valid: true,
        errors: null,
      });
    },
  );

  test("holds 10 to 15 articles, each in a file named by its id", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.length).toBeLessThanOrEqual(15);
    expect(files).toEqual(articles.map((a) => `${a.id}.yaml`).toSorted());
  });

  test("carries at least one exception and one tie-breaker", () => {
    expect(articles.some((a) => (a.exceptions ?? []).length > 0)).toBe(true);
    expect(articles.some((a) => (a.related?.tie_breakers ?? []).length > 0)).toBe(true);
  });

  test("every quote is a line of its source document, under the section it names", () => {
    const misses: string[] = [];
    for (const article of articles) {
      for (const span of [article.source, ...(article.exceptions ?? []).flatMap((e) => e.source ?? [])]) {
        const lines = sections(span.document).get(span.section);
        if (lines?.includes(span.quote) !== true) misses.push(`${article.id}: ${span.section}: ${span.quote}`);
      }
    }
    expect(misses).toEqual([]);
  });

  test("every related id names an article in the registry", () => {
    const dangling = articles.flatMap((a) =>
      [
        ...(a.related?.conflicts ?? []),
        ...(a.related?.supersedes ?? []),
        ...(a.related?.tie_breakers ?? []).map((t) => t.prevails_over),
      ].flatMap((id) => (ids.has(id) ? [] : [`${a.id} -> ${id}`])),
    );
    expect(dangling).toEqual([]);
  });

  test("every enforced_by entry covers an obligation its article states", () => {
    const orphans = articles.flatMap((a) => {
      const obligations = new Set([...(a.do ?? []), ...(a.dont ?? [])].map((o) => o.id));
      return (a.enforced_by ?? []).flatMap((e) => (obligations.has(e.covers) ? [] : [`${a.id}: ${e.covers}`]));
    });
    expect(orphans).toEqual([]);
  });
});

describe("article ids", () => {
  const article = articles[0];
  if (article === undefined) throw new Error("the fixture registry is empty");

  test.each(["SAFE-003", "MONEY2-14", "12", "0007"])("admits %s", (id) => {
    expect(validateArticle({ ...article, id })).toBe(true);
  });

  test.each(["safe-003", "SAFE-", "SAFE003", "-3", "SAFE-0003-1"])("refuses %s", (id) => {
    expect(validateArticle({ ...article, id })).toBe(false);
  });

  test("an id is a string, so a YAML number is refused rather than read as one", () => {
    expect(validateArticle({ ...article, id: 12 })).toBe(false);
  });
});

function withRegistry(registry: Readonly<Record<string, string>>) {
  return { ...project, constitution: { registry } };
}

describe("the project record's registry field", () => {
  test("is optional, so the template validates without it", () => {
    expect(validateProject(project)).toBe(true);
  });

  test.each([
    ["an overlay path", { path: "constitution/registry" }],
    ["an overlay path in a named repository", { path: "registry", repo: "example/overlay" }],
    ["a pinned package", { package: "@example/constitution", version: "2.1.0" }],
    [
      "a pinned package with a root inside it",
      { package: "@example/constitution", version: "2.1.0", path: "registry" },
    ],
  ])("admits %s", (_label, registry) => {
    expect(validateProject(withRegistry(registry))).toBe(true);
  });

  test.each([
    [
      "a repository and a package at once",
      { repo: "example/overlay", package: "@example/constitution", version: "2.1.0" },
    ],
    ["a package with no version", { package: "@example/constitution" }],
    ["a package version that is a range", { package: "@example/constitution", version: "^2.1.0" }],
    ["a path that leaves the repository", { path: "../registry" }],
    ["neither", {}],
  ])("refuses %s", (_label, registry) => {
    expect(validateProject(withRegistry(registry))).toBe(false);
  });

  test("refuses a constitution block that names no registry", () => {
    expect(validateProject({ ...project, constitution: {} })).toBe(false);
  });
});
