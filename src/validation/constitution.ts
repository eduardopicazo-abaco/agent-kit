/**
 * The constitution registry checks (ADR-0009 decision 4, plan ticket CS-21).
 *
 * A project record names its registry under `constitution.registry`; this
 * check reads the registry through that name and nothing else, because
 * agent-kit never reads overlay content except through the path or package a
 * project record names (ADR-0009, "agent-kit and the overlay"). The record
 * reaches the run as `ak validate --project <path>`, the flag `ak delegation`
 * already takes. With no record, or a record that names no registry, the check
 * returns nothing at all: not a note and not a skip, so the summary line is the
 * summary line of a run without it.
 *
 * The schema is the parser. An article the schema refuses is reported and
 * judged no further, except that its file name still answers for its id, so a
 * broken article does not cascade into unknown-id errors in the articles that
 * name it. Two of the schema's refusals are reported under ids of their own,
 * because the brief names them (`C:L72`), and are not repeated under
 * `constitution.article-invalid`, so each mistake fails once:
 *   - `constitution.missing-source-span`: no source, or a source without its
 *     document, section or quote. The source is what keeps the constitution
 *     the authority over the article compiled from it.
 *   - `constitution.enforced-by-without-predicate`: an entry that names a
 *     mechanism without the exact predicate it verifies, which is how a check
 *     that verifies part of an article comes to read as verifying all of it.
 */

import { readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

import { exists, isDir, isInside, readTextIfPresent, toPosix } from "../util/fs.ts";
import type { CheckContext } from "./context.ts";
import { compileSchemas } from "./schemas.ts";
import { error, skipped, unavailable, type Issue } from "./types.ts";

/** Where a registry keeps its articles, one per file, below its root. */
export const ARTICLES_DIR = "articles";

const SKIP_TERM = "constitution registry";
const ARTICLE_SCHEMA = "https://agent-kit.local/schemas/constitution-article.schema.json";
const PROJECT_SCHEMA = "https://agent-kit.local/schemas/project.schema.json";

/** The parts of an article the checks read; the schema guarantees the rest. */
export interface SourceSpan {
  readonly document: string;
  readonly section: string;
  readonly quote: string;
}

export interface Article {
  readonly id: string;
  readonly tier: "hard-constraint" | "default" | "judgment";
  readonly source: SourceSpan;
  readonly do?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly dont?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly exceptions?: ReadonlyArray<{ readonly id: string; readonly source?: SourceSpan }>;
  readonly related?: {
    readonly conflicts?: readonly string[];
    readonly tie_breakers?: ReadonlyArray<{ readonly prevails_over: string }>;
    readonly supersedes?: readonly string[];
  };
  readonly enforced_by?: ReadonlyArray<{
    readonly channel: "boundary" | "check" | "guard" | "review";
    readonly mechanism: string;
    readonly covers: string;
    readonly predicate: string;
  }>;
  readonly translation_fixtures?: ReadonlyArray<{ readonly covers?: string }>;
}

type Registry =
  | { readonly path: string; readonly repo?: string }
  | { readonly package: string; readonly version: string; readonly path?: string };

interface ProjectRecord {
  readonly kb: { readonly root: string };
  readonly constitution?: { readonly registry: Registry };
}

/** A path for an issue: repository-relative when the file is in the tree under inspection, absolute otherwise. */
function shown(root: string, path: string): string {
  return isInside(path, root) ? toPosix(relative(root, path)) || "." : toPosix(path);
}

/** The repository a file lives in: the nearest directory above it holding `.git`, or null. */
function repositoryOf(path: string): string | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (exists(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

export type RegistryResolution = { readonly root: string } | { readonly issues: Issue[] };

/**
 * Where the record's registry is, if this run can read it.
 *
 * An overlay path resolves against the repository the record lives in, which
 * is the knowledgebase repository (`kb.root`) unless `repo` names another. A
 * registry in another repository or in a package is not in reach of this
 * check: it reports a skip, so the summary says the registry went unexamined
 * instead of reading as a registry that passed.
 */
export function resolveRegistry(
  ctx: CheckContext,
  recordPath: string,
  record: ProjectRecord,
  registry: Registry,
): RegistryResolution {
  const file = shown(ctx.root, recordPath);
  const notLocal = (where: string): RegistryResolution => ({
    issues: [
      skipped(
        "constitution.registry-not-local",
        file,
        SKIP_TERM,
        `The registry is in ${where}, which this run cannot read: only a registry in the repository the record lives in is checked here.`,
      ),
    ],
  });
  if ("package" in registry) return notLocal(`package ${registry.package}@${registry.version}`);
  if (registry.repo !== undefined && registry.repo !== record.kb.root) return notLocal(`repository ${registry.repo}`);

  const repository = repositoryOf(recordPath);
  if (repository === null) {
    return {
      issues: [
        error(
          "constitution.registry-missing",
          file,
          `The record names registry path '${registry.path}', but the record lives in no repository, so there is no root to resolve the path against.`,
        ),
      ],
    };
  }
  const root = resolve(repository, registry.path);
  if (!isDir(join(root, ARTICLES_DIR))) {
    return {
      issues: [
        error(
          "constitution.registry-missing",
          file,
          `The record names registry path '${registry.path}', and ${shown(ctx.root, join(root, ARTICLES_DIR))}/ is not a directory.`,
        ),
      ],
    };
  }
  return { root };
}

type Refusal =
  | { readonly kind: "span"; readonly missing: string }
  | { readonly kind: "predicate"; readonly entry: string };

const BLANK = new Set(["minLength", "pattern"]);

/** The schema refusals the two named rules report, or null for any other. */
function refusal(e: ErrorObject): Refusal | null {
  const missing = e.keyword === "required" ? String(e.params["missingProperty"]) : null;
  if (e.instancePath === "" && missing === "source") return { kind: "span", missing: "source" };
  if (e.instancePath === "/source" && missing !== null) return { kind: "span", missing };
  if (e.instancePath === "/source" && e.keyword === "type") return { kind: "span", missing: "source" };
  const part = /^\/source\/(document|section|quote)$/.exec(e.instancePath)?.[1];
  if (part !== undefined && BLANK.has(e.keyword)) return { kind: "span", missing: part };
  const entry = /^\/enforced_by\/(\d+)$/.exec(e.instancePath)?.[1];
  if (entry !== undefined && missing === "predicate") return { kind: "predicate", entry };
  const blank = /^\/enforced_by\/(\d+)\/predicate$/.exec(e.instancePath)?.[1];
  if (blank !== undefined && BLANK.has(e.keyword)) return { kind: "predicate", entry: blank };
  return null;
}

function describe(errors: readonly ErrorObject[]): string {
  return errors
    .slice(0, 6)
    .map(
      (e) =>
        `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"} ${JSON.stringify(e.params)}`,
    )
    .join("; ");
}

/** Every refusal of one article, each under the one rule that names it. */
function refusalIssues(file: string, errors: readonly ErrorObject[]): Issue[] {
  const span = new Set<string>();
  const entries = new Set<string>();
  const rest: ErrorObject[] = [];
  for (const e of errors) {
    const found = refusal(e);
    if (found === null) rest.push(e);
    else if (found.kind === "span") span.add(found.missing);
    else entries.add(found.entry);
  }
  const issues: Issue[] = [];
  if (span.size > 0) {
    issues.push(
      error(
        "constitution.missing-source-span",
        file,
        span.has("source")
          ? "The article has no source span: name the document, section and quoted text it comes from."
          : `The article's source span has no ${[...span].join(", ")}: a span names the document, section and quoted text the article comes from.`,
      ),
    );
  }
  for (const entry of entries) {
    issues.push(
      error(
        "constitution.enforced-by-without-predicate",
        file,
        `enforced_by[${entry}] names no predicate: each entry states the exact predicate its mechanism verifies, which may be narrower than the obligation it covers.`,
      ),
    );
  }
  if (rest.length > 0) issues.push(error("constitution.article-invalid", file, describe(rest)));
  return issues;
}

export interface LoadedArticle {
  /** Absolute path of the article file. */
  readonly path: string;
  readonly article: Article;
}

export interface LoadedRegistry {
  /** The articles the schema admitted, in file-name order. */
  readonly articles: LoadedArticle[];
  /** Every id the registry answers for, including the file names of articles the schema refused. */
  readonly ids: ReadonlySet<string>;
  readonly issues: Issue[];
}

/**
 * Every article in the registry, parsed through the schema, with the issues
 * each file raised on its own. Shared with the coverage report, which reads the
 * same articles the validator judged.
 */
export function loadArticles(ctx: CheckContext, root: string, validate: ValidateFunction<Article>): LoadedRegistry {
  const dir = join(root, ARTICLES_DIR);
  const issues: Issue[] = [];
  const articles: LoadedArticle[] = [];
  const ids = new Set<string>();
  for (const name of readdirSync(dir).toSorted()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const file = shown(ctx.root, path);
    if (isDir(path) || !name.endsWith(".yaml")) {
      issues.push(
        error(
          "constitution.article-file-name",
          file,
          `Not an article file: ${ARTICLES_DIR}/ holds one article per <id>.yaml file and nothing else, so this file would go unexamined.`,
        ),
      );
      continue;
    }
    ids.add(name.slice(0, -".yaml".length));
    let value: unknown;
    try {
      value = parseYaml(readTextIfPresent(path) ?? "", { uniqueKeys: true });
    } catch (cause) {
      issues.push(
        error("constitution.article-unparseable", file, cause instanceof Error ? cause.message : String(cause)),
      );
      continue;
    }
    if (!validate(value)) {
      issues.push(...refusalIssues(file, validate.errors ?? []));
      continue;
    }
    if (name !== `${value.id}.yaml`) {
      issues.push(
        error(
          "constitution.article-file-name",
          file,
          `The article's id is ${value.id}, so its file is ${value.id}.yaml.`,
        ),
      );
      ids.add(value.id);
    }
    articles.push({ path, article: value });
  }
  return { articles, ids, issues };
}

/** The text under a heading of a Markdown document, up to the next heading at its level or above. */
function sectionText(document: string, section: string): string | null {
  const lines = document.split("\n");
  const at = lines.findIndex((line) => /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1] === section);
  if (at === -1) return null;
  const level = /^#+/.exec(lines[at] ?? "")?.[0].length ?? 0;
  const end = lines.findIndex((line, i) => i > at && (/^(#{1,6})\s/.exec(line)?.[1]?.length ?? 7) <= level);
  return lines.slice(at + 1, end === -1 ? undefined : end).join("\n");
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Each source span an article carries, its own and its exceptions', checked
 * against the document: the document exists inside the registry, the section is
 * one of its headings, and the quote is the source's own words under it.
 * Whitespace is compared loosely, since a wrapped line is the same words.
 */
function checkSpans(ctx: CheckContext, root: string, { path: file, article }: LoadedArticle): Issue[] {
  const spans = [article.source, ...(article.exceptions ?? []).flatMap((e) => e.source ?? [])];
  return spans.flatMap((span) => {
    const path = resolve(root, span.document);
    const text = isInside(path, root) ? readTextIfPresent(path) : null;
    const body = text === null ? null : sectionText(text, span.section);
    const problem =
      text === null
        ? `its document ${span.document} is not a file inside the registry`
        : body === null
          ? `${span.document} has no heading '${span.section}'`
          : squash(body).includes(squash(span.quote))
            ? null
            : `the quote is not in ${span.document} under '${span.section}'`;
    return problem === null
      ? []
      : [
          error(
            "constitution.source-span-unresolved",
            shown(ctx.root, file),
            `A source span does not resolve: ${problem}. The quote is the source's own words, never a paraphrase.`,
          ),
        ];
  });
}

/** Obligation ids are unique, and whatever names one names one the article states. */
function checkObligations(ctx: CheckContext, { path, article }: LoadedArticle): Issue[] {
  const file = shown(ctx.root, path);
  const ids = [...(article.do ?? []), ...(article.dont ?? [])].map((o) => o.id);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].map((id) =>
    error(
      "constitution.duplicate-obligation-id",
      file,
      `Obligation id '${id}' is used more than once across do and dont, so coverage cannot tell which one an entry covers.`,
    ),
  );
  const known = new Set(ids);
  const naming = [
    ...(article.enforced_by ?? []).map((e, i) => [`enforced_by[${i}]`, e.covers] as const),
    ...(article.translation_fixtures ?? []).map((f, i) => [`translation_fixtures[${i}]`, f.covers] as const),
  ];
  const unknown = naming.flatMap(([where, covers]) =>
    covers === undefined || known.has(covers)
      ? []
      : [
          error(
            "constitution.unknown-obligation",
            file,
            `${where} covers '${covers}', which is not the id of a do or dont obligation in this article.`,
          ),
        ],
  );
  return [...duplicates, ...unknown];
}

/** Related ids (conflicts, tie-breakers, supersedes) name articles in the registry. */
function checkRelated(ctx: CheckContext, { path, article }: LoadedArticle, ids: ReadonlySet<string>): Issue[] {
  const related = article.related ?? {};
  const named = [
    ...(related.conflicts ?? []).map((id) => ["conflicts", id] as const),
    ...(related.tie_breakers ?? []).map((t) => ["tie_breakers", t.prevails_over] as const),
    ...(related.supersedes ?? []).map((id) => ["supersedes", id] as const),
  ];
  return named.flatMap(([field, id]) =>
    ids.has(id)
      ? []
      : [
          error(
            "constitution.unknown-related-id",
            shown(ctx.root, path),
            `related.${field} names ${id}, which is not an article in this registry.`,
          ),
        ],
  );
}

/**
 * Tie-breakers that resolve in a circle. Each one says its article prevails
 * over another; a cycle leaves a collision with no winner. A tie-breaker's
 * `when` is prose this check cannot compare, so a cycle is refused even where
 * the conditions might never hold together: the registry states the order
 * outright rather than relying on two conditions being disjoint.
 */
function checkTieBreakerCycles(ctx: CheckContext, articles: readonly LoadedArticle[]): Issue[] {
  const byId = new Map(articles.map((loaded) => [loaded.article.id, loaded] as const));
  const edges = new Map(
    [...byId].map(([id, { article }]) => [
      id,
      [...new Set((article.related?.tie_breakers ?? []).map((t) => t.prevails_over))]
        .flatMap((over) => (byId.has(over) ? [over] : []))
        .toSorted(),
    ]),
  );

  // Tarjan's strongly connected components; a component of two or more, or one
  // article prevailing over itself, is a cycle.
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
      onStack.delete(w);
      component.push(w);
      if (w === v) break;
    }
    components.push(component.toSorted());
  };
  for (const id of [...edges.keys()].toSorted()) if (!index.has(id)) visit(id);

  return components
    .toSorted((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))
    .flatMap((component) => {
      const first = component[0] ?? "";
      if (component.length === 1 && !(edges.get(first) ?? []).includes(first)) return [];
      const members = new Set(component);
      const steps = component.flatMap((from) =>
        (edges.get(from) ?? []).flatMap((to) => (members.has(to) ? [`${from} prevails over ${to}`] : [])),
      );
      const owner = byId.get(first);
      return [
        error(
          "constitution.tie-breaker-cycle",
          owner === undefined ? "-" : shown(ctx.root, owner.path),
          `Tie-breakers among ${component.join(", ")} form a cycle (${steps.join("; ")}), so a collision between them has no winner.`,
        ),
      ];
    });
}

/** The project record `--project` names, parsed through its schema, or why it could not be. */
function readRecord(
  ctx: CheckContext,
  recordPath: string,
  validate: ValidateFunction<ProjectRecord>,
): { readonly record: ProjectRecord } | { readonly issues: Issue[] } {
  const file = shown(ctx.root, recordPath);
  const text = readTextIfPresent(recordPath);
  if (text === null) {
    return { issues: [error("constitution.project-unreadable", file, "The project record could not be read.")] };
  }
  let value: unknown;
  try {
    value = recordPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { issues: [error("constitution.project-unreadable", file, message)] };
  }
  if (!validate(value)) {
    return {
      issues: [
        error(
          "constitution.project-invalid",
          file,
          `The project record does not match its schema, so whatever it says about a registry is not trusted: ${describe(validate.errors ?? [])}`,
        ),
      ],
    };
  }
  return { record: value };
}

export function checkConstitution(ctx: CheckContext): Issue[] {
  if (ctx.project === undefined) return [];
  const recordPath = isAbsolute(ctx.project) ? ctx.project : resolve(ctx.root, ctx.project);

  const { ajv } = compileSchemas(ctx.root);
  const validateProject = ajv.getSchema<ProjectRecord>(PROJECT_SCHEMA);
  const validateArticle = ajv.getSchema<Article>(ARTICLE_SCHEMA);
  if (validateProject === undefined || validateArticle === undefined) {
    // The schemas check reports why they did not compile. The record was named
    // and its authority is not there, so the run does not pass on it.
    return [
      unavailable(
        "constitution.schema-unavailable",
        "schemas",
        SKIP_TERM,
        "The project or constitution-article schema did not compile, so the record and the registry it names were not checked against them.",
      ),
    ];
  }

  const read = readRecord(ctx, recordPath, validateProject);
  if ("issues" in read) return read.issues;
  const registry = read.record.constitution?.registry;
  if (registry === undefined) return [];

  const resolution = resolveRegistry(ctx, recordPath, read.record, registry);
  if ("issues" in resolution) return resolution.issues;

  const loaded = loadArticles(ctx, resolution.root, validateArticle);
  return [
    ...loaded.issues,
    ...loaded.articles.flatMap((article) => [
      ...checkSpans(ctx, resolution.root, article),
      ...checkObligations(ctx, article),
      ...checkRelated(ctx, article, loaded.ids),
    ]),
    ...checkTieBreakerCycles(ctx, loaded.articles),
  ];
}
