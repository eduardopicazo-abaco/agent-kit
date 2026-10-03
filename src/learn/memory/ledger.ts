/**
 * The memory ledger: `<configDir>/projects/<folder>/agent-kit/memory/`.
 *
 * | File | What |
 * |---|---|
 * | `memory.md` | the organized working memory; the only prose injected at session start, with confirmed lessons |
 * | `episodes.jsonl` | one record per completed claude-mem session, with its priority |
 * | `raw/consolidated.jsonl`, `raw/undone-runs.jsonl` | which run consolidated which session, and the runs a rollback undid |
 * | `raw/pending-review-events.jsonl` | review events waiting for the review ledger's lock; emptied once delivered |
 * | `lessons/ls-NNN.md`, `lessons.md` | typed lessons and their index |
 * | `runs.jsonl`, `log.md`, `.state.json` | the run record, the log, and the watermarks and mute switch |
 *
 * `memory.md` and the lessons are the revertible wiki layer; `episodes.jsonl`
 * and `runs.jsonl` are raw and are never rolled back.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LearnConfig } from "../core/config.ts";
import type { LearnContext } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import { parsePage, renderPage, type PageMeta } from "../core/pages.ts";
import { loopDir } from "../core/paths.ts";
import { appendJsonl, nowIso, nowMs, readJson, readText, writeJson } from "../core/store.ts";
import { lessonDraft, proposeLesson, type ProposalResult, type TriggerKind } from "../kb.ts";

/** The six sections a reflected memory must carry, in order. */
export const SECTIONS = [
  "## Current state",
  "## Decisions",
  "## Unresolved",
  "## Preferences & corrections",
  "## Environment gotchas",
  "## Completed ✅ (last 7 days)",
] as const;

/** Observation types that count as a failure signal. */
export const FAILURE_TYPES = new Set([
  "review-finding",
  "test-failure",
  "error",
  "security_alert",
  "critical-issue",
  "blocker",
]);

export const LESSONS_INDEX_HEAD =
  "# Lessons\n\n| id | status | scope | confidence | last seen | statement |\n|---|---|---|---|---|---|\n";

const SEED: Readonly<Record<string, string>> = {
  "memory.md": "",
  "episodes.jsonl": "",
  "runs.jsonl": "",
  "log.md": "# memory log\n",
  "lessons.md": LESSONS_INDEX_HEAD,
  ".state.json": "{}",
  ".gitignore": ".lock*\n",
};

export interface MemoryState {
  last_obs_id_reflected?: number;
  last_reflect?: number;
  last_reflect_attempt?: number;
  reflect_failures?: number;
  /** Local calendar date of the last nightly run. */
  last_nightly?: string;
  last_nightly_attempt?: number;
  nightly_failures?: number;
  last_weekly?: number;
  muted?: boolean;
}

/** The ledger directory for a project root. Pure path arithmetic; never touches the repository. */
export function memoryDir(config: LearnConfig, root: string): string {
  return loopDir(config, root, "memory");
}

/** Create any missing seed files and the git history. Safe on every run. */
export function ensureMemoryLedger(dir: string): Ledger {
  const ledger = new Ledger(dir).ensure(SEED, "init memory ledger");
  mkdirSync(ledger.path("lessons"), { recursive: true });
  return ledger;
}

export function readState(ledger: Ledger): MemoryState {
  return readJson<MemoryState>(ledger.path(".state.json"), {});
}

export function saveState(ledger: Ledger, state: MemoryState): void {
  writeJson(ledger.path(".state.json"), state);
}

export function appendRun(ledger: Ledger, run: Record<string, unknown>): void {
  appendJsonl(ledger.path("runs.jsonl"), [{ ts: nowIso(), ...run }]);
}

export function logLine(ledger: Ledger, message: string): void {
  appendFileSync(ledger.path("log.md"), `- ${nowIso()} ${message}\n`);
}

/** Session id as cited in memory: `S` plus its first eight characters. */
export function sid8(sid: string): string {
  return `S${sid.slice(0, 8)}`;
}

const HEADINGS: ReadonlySet<string> = new Set(SECTIONS);

const ID_RE = /\b(obs:\d+|S[0-9a-f][0-9a-f-]{5,})\b/g;

export function citedIds(text: string | null | undefined): Set<string> {
  return new Set([...(text ?? "").matchAll(ID_RE)].map((match) => match[1]!));
}

/**
 * The evidence gate. A blank line or one of the six `SECTIONS` headings
 * (trailing whitespace ignored) passes; every other line must be a `- ` bullet
 * citing at least one id, all of them in `valid`. Any line that fails is
 * dropped and counted, so prose, `*` bullets, an invented or misspelt heading
 * and a bullet padding one real id with invented ones cannot carry a claim
 * into the ledger.
 * `candidates` is how many lines had to pass, the base for the "more than
 * half dropped" rejection.
 */
export function provenanceGate(
  lines: readonly string[],
  valid: ReadonlySet<string>,
): { kept: string[]; dropped: number; candidates: number } {
  const kept: string[] = [];
  let dropped = 0;
  let candidates = 0;
  for (const line of lines) {
    if (line.trim() === "" || HEADINGS.has(line.trimEnd())) {
      kept.push(line);
      continue;
    }
    candidates += 1;
    const cited = [...citedIds(line)];
    if (line.trimStart().startsWith("- ") && cited.length > 0 && cited.every((id) => valid.has(id))) kept.push(line);
    else dropped += 1;
  }
  return { kept, dropped, candidates };
}

/** `text.splitlines()`: no trailing empty line for a final newline. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// --- lessons -----------------------------------------------------------------

export interface LessonPage {
  meta: PageMeta;
  body: string;
  path: string;
}

const LESSON_FILE = /^ls-\d{1,6}\.md$/;

/** A lesson's id is its file name (`ls-003.md` is `ls-003`), never its frontmatter, which a judge's text once reached. */
export function lessonId(page: LessonPage): string {
  return basename(page.path, ".md");
}

/** Lesson pages keyed by id, in file-name order. Each page's `meta.id` is overwritten with the file-derived id. */
export function loadLessons(ledger: Ledger): Map<string, LessonPage> {
  const dir = ledger.path("lessons");
  const out = new Map<string, LessonPage>();
  if (!existsSync(dir)) return out;
  const names = readdirSync(dir)
    .filter((name) => LESSON_FILE.test(name))
    .sort();
  for (const name of names) {
    const path = join(dir, name);
    const { meta, body } = parsePage(readText(path));
    const id = basename(name, ".md");
    out.set(id, { meta: { ...meta, id }, body, path });
  }
  return out;
}

/** Judge-supplied prose as one line: control characters become spaces, runs of whitespace collapse, capped at `max`. */
export function oneLine(value: unknown, max = 1000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Judge-supplied tags: lowercase `[a-z0-9_-]`, at most 32 characters, at most 12 distinct. Anything else is dropped, not repaired. */
export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase());
  return [...new Set(tags.filter((tag) => TAG.test(tag)))].slice(0, 12);
}

export function writeLesson(path: string, meta: PageMeta, body: string): void {
  writeFileSync(path, renderPage(meta, body));
}

export function list(value: PageMeta[string] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: PageMeta[string] | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function lessonsIndexText(ledger: Ledger): string {
  const rows = [...loadLessons(ledger).values()].map(
    ({ meta }) => `${str(meta.id)} [${str(meta.status)}] ${str(meta.statement)}`,
  );
  return rows.length > 0 ? rows.join("\n") : "(none)";
}

export function rewriteIndex(ledger: Ledger): void {
  const rows = [...loadLessons(ledger).values()].map(({ meta }) => {
    const cells = [meta.id, meta.status, meta.scope, meta.confidence, meta.last_seen].map(str);
    return `| ${cells.join(" | ")} | ${str(meta.statement).replaceAll("|", "/")} |`;
  });
  writeFileSync(ledger.path("lessons.md"), LESSONS_INDEX_HEAD + rows.join("\n") + (rows.length > 0 ? "\n" : ""));
}

// --- knowledgebase -----------------------------------------------------------

/**
 * A newly confirmed lesson becomes a candidate draft for the knowledgebase.
 * Never published from here (ruling `learning-drafts-not-publishes`). The
 * project revision is left null: the scheduled path may not run git in a
 * repository.
 */
export function proposeConfirmed(
  ctx: LearnContext,
  ledger: Ledger,
  root: string,
  page: LessonPage,
  options: { runId: string; createdBy: "learn/consolidator" | "learn/lesson-merger"; trigger: TriggerKind },
): ProposalResult {
  const { meta } = page;
  const id = lessonId(page);
  const statement = oneLine(str(meta.statement));
  const evidence = list(meta.evidence);
  const scope = str(meta.scope) || "repo";
  const domains = [...new Set([scope, ...cleanTags(list(meta.tags))])];
  const title = statement.length <= 80 ? statement : `${statement.slice(0, 77).replace(/\s+\S*$/, "")}...`;
  const draft = lessonDraft(
    {
      localId: id,
      title,
      statement,
      trigger: options.trigger,
      occurrence: { id: evidence[0] ?? id, content: { statement, evidence } },
      evidence: evidence.map((ref) => ({ ref: `claude-mem:${ref}`, kind: "transcript" as const })),
      domains,
      createdBy: options.createdBy,
    },
    { root, revision: null },
    options.runId,
  );
  return proposeLesson(ctx, ledger.dir, draft);
}

/**
 * `proposeConfirmed`, but a refused draft (a malformed id, an unwritable
 * proposals directory) is logged and skipped rather than aborting the run that
 * confirmed the lesson halfway.
 */
export function proposeOrSkip(
  ctx: LearnContext,
  ledger: Ledger,
  root: string,
  page: LessonPage,
  options: Parameters<typeof proposeConfirmed>[4],
): { ref: string } | { skipped: string } {
  try {
    return { ref: proposeConfirmed(ctx, ledger, root, page, options).ref };
  } catch (error) {
    const reason = `${lessonId(page)}: ${(error as Error).message}`;
    logLine(ledger, `proposal skipped ${reason}`);
    ctx.io.err(`ak learn memory: proposal skipped ${reason}`);
    return { skipped: reason };
  }
}

export function ageWords(ms: number | undefined, now = nowMs()): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  for (const [unit, n] of [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ] as const) {
    if (s >= n) return `${Math.floor(s / n)}${unit}`;
  }
  return `${s}s`;
}
