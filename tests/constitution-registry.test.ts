/**
 * The registry checks `ak validate` runs when a project record names a
 * constitution registry (ADR-0009 decision 4, plan ticket CS-21).
 *
 * Every broken registry below is the invented fixture registry with one change,
 * copied into a throwaway repository, so each case fails for the one reason it
 * names: the assertion is the complete set of constitution rule ids the run
 * reports, not a subset it must contain.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parseDocument, type Document } from "yaml";

import { runCli } from "../src/cli.ts";
import { runValidation } from "../src/validation/run.ts";
import type { Issue } from "../src/validation/types.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "constitution");
const RECORD = readFileSync(join(FIXTURES, "project.json"), "utf8");

type Registry = { path: string; repo?: string } | { package: string; version: string };

function constitutionIssues(project: string | undefined): Issue[] {
  return runValidation(ROOT, { only: ["constitution"], project }).issues.filter((i) =>
    i.rule.startsWith("constitution."),
  );
}

/**
 * The fixture project record, with its registry replaced (or removed), written
 * into `dir`. YAML is a superset of JSON and the check reads a record that is
 * not `.json` as YAML, so the edited document is written as YAML.
 */
function writeRecord(dir: string, registry: Registry | null, edit?: (record: Document) => void): string {
  const path = join(dir, "project.yaml");
  const record = parseDocument(RECORD);
  if (registry === null) record.deleteIn(["constitution"]);
  else record.setIn(["constitution", "registry"], record.createNode(registry));
  edit?.(record);
  writeFileSync(path, String(record));
  return path;
}

function freshRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "ak-constitution-"));
  mkdirSync(join(repo, ".git"));
  return repo;
}

/** A repository holding a copy of the fixture registry at `registry/`, with `change` applied to its articles. */
function brokenRegistry(change: (articles: Map<string, Document>, dir: string) => void): Issue[] {
  const repo = freshRepository();
  cpSync(join(FIXTURES, "registry"), join(repo, "registry"), { recursive: true });
  const dir = join(repo, "registry", "articles");
  const articles = new Map<string, Document>();
  for (const name of readdirSync(dir)) {
    articles.set(name.replace(/\.yaml$/, ""), parseDocument(readFileSync(join(dir, name), "utf8")));
  }
  change(articles, dir);
  for (const [id, document] of articles) writeFileSync(join(dir, `${id}.yaml`), String(document));
  return constitutionIssues(writeRecord(repo, { path: "registry" }));
}

function articleOf(articles: Map<string, Document>, id: string): Document {
  const found = articles.get(id);
  if (found === undefined) throw new Error(`the fixture registry has no ${id}`);
  return found;
}

const errorRules = (issues: readonly Issue[]) => [...new Set(issues.map((i) => i.rule))].toSorted();

function summary(argv: string[]): string {
  const out: string[] = [];
  runCli(argv, { cwd: ROOT, io: { out: (l) => out.push(l), err: (l) => out.push(l) } });
  return out.findLast((l) => l.startsWith("ak validate:")) ?? "";
}

describe("a registry the record names", () => {
  test("the invented fixture registry passes every check", () => {
    expect(constitutionIssues(join(FIXTURES, "project.json"))).toEqual([]);
  });

  test("an article with no source span fails constitution.missing-source-span, and only that", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "SAFE-001").deleteIn(["source"]);
    });
    expect(errorRules(issues)).toEqual(["constitution.missing-source-span"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toEndWith("registry/articles/SAFE-001.yaml");
    expect(issues[0]?.message).toMatch(/no source span/);
  });

  test("a span without its quote is no span either, and the message names the missing part", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "DATA-001").setIn(["source", "quote"], " ");
    });
    expect(errorRules(issues)).toEqual(["constitution.missing-source-span"]);
    expect(issues[0]?.message).toMatch(/has no quote/);
  });

  test("an enforced_by entry with no predicate fails constitution.enforced-by-without-predicate, and only that", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "FAIL-001").deleteIn(["enforced_by", 1, "predicate"]);
    });
    expect(errorRules(issues)).toEqual(["constitution.enforced-by-without-predicate"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/enforced_by\[1\] names no predicate/);
  });

  test("a related id that names no article fails constitution.unknown-related-id", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "FAIL-001").addIn(["related", "conflicts"], "AVAIL-009");
    });
    expect(errorRules(issues)).toEqual(["constitution.unknown-related-id"]);
    expect(issues[0]?.message).toMatch(/related\.conflicts names AVAIL-009/);
  });

  test("tie-breakers that resolve in a circle fail constitution.tie-breaker-cycle, once per cycle", () => {
    const issues = brokenRegistry((articles) => {
      const availability = articleOf(articles, "AVAIL-001");
      availability.setIn(
        ["related", "tie_breakers"],
        availability.createNode([{ prevails_over: "FAIL-001", reason: "An invented reverse ordering." }]),
      );
    });
    expect(errorRules(issues)).toEqual(["constitution.tie-breaker-cycle"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/among AVAIL-001, FAIL-001 form a cycle/);
  });

  test("an article prevailing over itself is a cycle of one", () => {
    const issues = brokenRegistry((articles) => {
      const operations = articleOf(articles, "OPS-001");
      operations.setIn(
        ["related", "tie_breakers"],
        operations.createNode([{ prevails_over: "OPS-001", reason: "An invented self-reference." }]),
      );
    });
    expect(errorRules(issues)).toEqual(["constitution.tie-breaker-cycle"]);
  });

  test("a quote that is not the source's own words fails constitution.source-span-unresolved", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "SAFE-002").setIn(["source", "quote"], "Secrets rarely enter a repository.");
    });
    expect(errorRules(issues)).toEqual(["constitution.source-span-unresolved"]);
    expect(issues[0]?.message).toMatch(/the quote is not in source\/constitution\.md/);
  });

  test("a section the document does not have fails constitution.source-span-unresolved", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "TEST-001").setIn(["source", "section"], "9. Nowhere");
    });
    expect(errorRules(issues)).toEqual(["constitution.source-span-unresolved"]);
    expect(issues[0]?.message).toMatch(/has no heading '9\. Nowhere'/);
  });

  test("an article in a file not named by its id fails constitution.article-file-name", () => {
    const issues = brokenRegistry((articles, dir) => {
      articles.delete("CODE-001");
      renameSync(join(dir, "CODE-001.yaml"), join(dir, "CODE-009.yaml"));
    });
    expect(errorRules(issues)).toEqual(["constitution.article-file-name"]);
    expect(issues[0]?.message).toMatch(/its file is CODE-001\.yaml/);
  });

  test("a file in articles/ that is not an article file is reported, not skipped", () => {
    const issues = brokenRegistry((_articles, dir) => {
      writeFileSync(join(dir, "notes.md"), "Invented notes.\n");
    });
    expect(errorRules(issues)).toEqual(["constitution.article-file-name"]);
  });

  test("an enforced_by entry covering no stated obligation fails constitution.unknown-obligation", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "FAIL-001").setIn(["enforced_by", 0, "covers"], "no-such-obligation");
    });
    expect(errorRules(issues)).toEqual(["constitution.unknown-obligation"]);
  });

  test("an obligation id used twice fails constitution.duplicate-obligation-id", () => {
    const issues = brokenRegistry((articles) => {
      const failure = articleOf(articles, "FAIL-001");
      failure.setIn(["do", 0, "id"], "no-silent-fallback");
      failure.setIn(["enforced_by", 1, "covers"], "no-silent-fallback");
    });
    expect(errorRules(issues)).toEqual(["constitution.duplicate-obligation-id"]);
  });

  test("any other schema failure is constitution.article-invalid", () => {
    const issues = brokenRegistry((articles) => {
      articleOf(articles, "TEST-002").setIn(["tier"], "preference");
    });
    expect(errorRules(issues)).toEqual(["constitution.article-invalid"]);
    expect(issues[0]?.message).toMatch(/\/tier/);
  });

  test("a file that is not YAML fails constitution.article-unparseable", () => {
    const issues = brokenRegistry((articles, dir) => {
      articles.delete("OPS-001");
      writeFileSync(join(dir, "OPS-001.yaml"), "id: OPS-001\nid: OPS-002\n");
    });
    // OPS-001 is related to nothing, so its absence from the parsed set
    // cascades to no other article.
    expect(errorRules(issues)).toEqual(["constitution.article-unparseable"]);
  });
});

describe("where the registry is", () => {
  test("a record that names no registry reports nothing", () => {
    expect(constitutionIssues(writeRecord(freshRepository(), null))).toEqual([]);
  });

  test("a registry path with no articles/ under it fails constitution.registry-missing", () => {
    const issues = constitutionIssues(writeRecord(freshRepository(), { path: "constitution/registry" }));
    expect(errorRules(issues)).toEqual(["constitution.registry-missing"]);
  });

  test("a path in the knowledgebase repository named outright resolves like a bare path", () => {
    const issues = constitutionIssues(
      writeRecord(freshRepository(), { path: "constitution/registry", repo: "example/seed-kb" }),
    );
    expect(errorRules(issues)).toEqual(["constitution.registry-missing"]);
  });

  test("a registry in another repository or a package is a skip, never a pass", () => {
    for (const registry of [
      { path: "registry", repo: "example/seed-exchange" },
      { package: "@example/seed-constitution", version: "1.0.0" },
    ]) {
      const issues = constitutionIssues(writeRecord(freshRepository(), registry));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ rule: "constitution.registry-not-local", skipped: "constitution registry" });
      expect(issues[0]?.blocking).toBeUndefined();
    }
  });

  test("a record that does not match the project schema is not trusted to name a registry", () => {
    const record = writeRecord(freshRepository(), { path: "registry" }, (r) => r.deleteIn(["limits"]));
    expect(errorRules(constitutionIssues(record))).toEqual(["constitution.project-invalid"]);
  });

  test("a record that cannot be read fails constitution.project-unreadable", () => {
    expect(errorRules(constitutionIssues(join(tmpdir(), "ak-no-such-record.json")))).toEqual([
      "constitution.project-unreadable",
    ]);
  });
});

describe("with no registry configured", () => {
  test("`ak validate --project` on a record without one prints the summary `ak validate` prints", () => {
    const record = writeRecord(freshRepository(), null);
    const plain = summary(["validate"]);
    expect(plain).toMatch(/^ak validate: \d+ errors?/);
    expect(summary(["validate", "--project", record])).toBe(plain);
  }, 60_000);

  test("no project record at all runs the check and reports nothing", () => {
    expect(constitutionIssues(undefined)).toEqual([]);
  });
});
