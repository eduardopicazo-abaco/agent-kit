/**
 * Nightly consolidation: stratified episodes become typed lessons, plus review
 * events for the review loop. One judge call (role `consolidator`).
 *
 * The batch is 40% failures and corrections, 40% successful repeats and 20%
 * novelty, by priority within each stratum. A failure episode is paired with
 * the later completed episode on the same files (contrastive replay). Only the
 * episodes that fit under the input cap reach the judge, so only they are
 * marked consolidated and only their ids pass the evidence gate.
 *
 * A lesson is `confirmed` when its evidence spans two or more sessions and
 * `hypothesis` otherwise. A newly confirmed lesson becomes a knowledgebase
 * draft, never a publication.
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import type { Ledger } from "../core/ledger.ts";
import type { PageMeta } from "../core/pages.ts";
import { renderPage } from "../core/pages.ts";
import { buildPrompt } from "../core/roles.ts";
import { appendJsonl, nowIso, nowMs, readJsonl, todayLocal, tokens } from "../core/store.ts";
import { appendEvents, makeEvent, type ReviewEvent } from "../review/events.ts";
import type { ClaudeMemSource, ObservationRow } from "../sources/claude-mem.ts";
import { type Episode, loadEpisodes, markConsolidated, MEMORY_SOURCE, unconsolidatedEpisodes } from "./episodes.ts";
import {
  appendRun,
  cleanTags,
  FAILURE_TYPES,
  list,
  loadLessons,
  lessonsIndexText,
  logLine,
  oneLine,
  proposeOrSkip,
  readState,
  rewriteIndex,
  saveState,
  sid8,
  str,
  writeLesson,
} from "./ledger.ts";

export const INPUT_CHARS = 80_000;
export const OBS_PER_EPISODE = 15;
const SCOPES = new Set(["repo", "subtree", "technology", "global"]);

type Stratifiable = Pick<
  Episode,
  "sid" | "started" | "completed" | "files_modified" | "failure_signals" | "corrections" | "priority"
>;

/** Up to `batch` episodes: 40% failures/corrections, 40% successful repeats, 20% novelty; priority descending within each. */
export function stratify<T extends Stratifiable>(
  episodes: readonly T[],
  batch: number,
): { chosen: T[]; failures: T[] } {
  const seen = new Set<string>();
  const repeats = new Set<string>();
  for (const episode of [...episodes].sort((a, b) => a.started - b.started)) {
    if (episode.completed && episode.files_modified.some((path) => seen.has(path))) repeats.add(episode.sid);
    for (const path of episode.files_modified) seen.add(path);
  }
  const byPriority = (a: T, b: T) => b.priority - a.priority;
  const fail = episodes.filter((episode) => episode.failure_signals > 0 || episode.corrections > 0).sort(byPriority);
  const failSids = new Set(fail.map((episode) => episode.sid));
  const rep = episodes.filter((episode) => repeats.has(episode.sid) && !failSids.has(episode.sid)).sort(byPriority);
  const repSids = new Set(rep.map((episode) => episode.sid));
  const nov = episodes.filter((episode) => !failSids.has(episode.sid) && !repSids.has(episode.sid)).sort(byPriority);
  const quota = [Math.round(batch * 0.4), Math.round(batch * 0.4)];
  quota.push(batch - quota[0]! - quota[1]!);
  const chosen = [...fail.slice(0, quota[0]), ...rep.slice(0, quota[1]), ...nov.slice(0, quota[2])];
  const rest = [...fail.slice(quota[0]), ...rep.slice(quota[1]), ...nov.slice(quota[2])].sort(byPriority);
  chosen.push(...rest.slice(0, Math.max(0, batch - chosen.length)));
  return { chosen, failures: fail.slice(0, quota[0]) };
}

/** Each failure with the earliest later completed episode that shares a modified file. */
export function pairFailures<T extends Stratifiable>(failures: readonly T[], all: readonly T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (const failure of failures) {
    const later = all.filter(
      (episode) =>
        episode.started > failure.started &&
        episode.completed &&
        episode.files_modified.some((path) => failure.files_modified.includes(path)),
    );
    if (later.length > 0) pairs.push([failure, later.reduce((a, b) => (b.started < a.started ? b : a))]);
  }
  return pairs;
}

/** A session's observations, failures first, then decisions, then the rest; capped. */
export function fetchObs(source: ClaudeMemSource, sid: string, cap = OBS_PER_EPISODE): ObservationRow[] {
  const rank = (row: ObservationRow) => (FAILURE_TYPES.has(row.type) ? 0 : row.type === "decision" ? 1 : 2);
  return [...source.sessionObservations(sid)].sort((a, b) => rank(a) - rank(b) || a.id - b.id).slice(0, cap);
}

export function formatEpisode(episode: Episode, rows: readonly ObservationRow[]): string {
  const head =
    `${sid8(episode.sid)} ${episode.platform} start=${episode.started} completed=${episode.completed ? "True" : "False"} ` +
    `failure_signals=${episode.failure_signals} corrections=${episode.corrections} priority=${episode.priority}\n` +
    `  request: ${(episode.request ?? "").slice(0, 300)}\n` +
    `  files: ${episode.files_modified.slice(0, 12).join(", ")}\n`;
  const body = rows
    .map(
      (row) =>
        `  obs:${row.id} [${row.type}] ${row.title ?? ""} — ${(row.subtitle ?? "").slice(0, 160)}` +
        (row.facts ? ` | ${row.facts.slice(0, 300)}` : "") +
        "\n",
    )
    .join("");
  return head + body;
}

export const OUTPUT_CONTRACT = `Reply with one object:
{"lessons": [{"statement": "...", "scope": "repo", "evidence": ["obs:123", "S1a2b3c4d"], "confidence": 0.7, "supersedes": [], "tags": []}],
 "review_events": [{"text": "...", "kind": "finding", "evidence": ["obs:123"], "files": ["path"]}],
 "log": "one line on what this batch covered"}
- evidence: ids copied verbatim from the episodes below. A lesson or review event with no such id is deleted.
- scope: one of repo | subtree | technology | global. confidence: 0..1. At most 8 lessons.
- tags may include: decision, security, blocker, preference, contrastive.
- supersedes: only ids (ls-NNN) listed under existing lessons.
- review_events kind: finding | correction. Leave the list empty when there are none.
- Status, ids, session counts and dates are set by the runtime; any you send are ignored.`;

/** The prompt and the episodes that fit in it. Only `included` reached the judge. */
export function consolidatePrompt(
  ctx: LearnContext,
  ledger: Ledger,
  chosen: readonly Episode[],
  pairs: ReadonlyArray<[Episode, Episode]>,
  obsBySid: ReadonlyMap<string, ObservationRow[]>,
  inputChars = INPUT_CHARS,
): { prompt: string; included: Episode[] } {
  const texts: string[] = [];
  const included: Episode[] = [];
  let used = 0;
  for (const episode of chosen) {
    const text = formatEpisode(episode, obsBySid.get(episode.sid) ?? []);
    if (used + text.length > inputChars) break;
    used += text.length;
    texts.push(text);
    included.push(episode);
  }
  const pairText =
    pairs
      .map(([failure, success]) => {
        const shared = failure.files_modified
          .filter((path) => success.files_modified.includes(path))
          .sort()
          .slice(0, 6);
        return `${sid8(failure.sid)} -> ${sid8(success.sid)} (shared files: ${shared.join(", ")})`;
      })
      .join("\n") || "(none)";
  const prompt = buildPrompt(
    "consolidator",
    OUTPUT_CONTRACT,
    [
      { title: "Existing lessons", body: lessonsIndexText(ledger) },
      {
        title: "Failure pairs (failed or corrected episode -> later completed episode on the same files)",
        body: pairText,
      },
      { title: "Episodes", body: texts.join("\n") || "(none)" },
    ],
    ctx.env,
  );
  return { prompt, included };
}

/** Distinct sessions an evidence list spans: `S<sid>` directly, `obs:N` through the observation-to-session map. */
export function sessionsOf(evidence: readonly string[], obsSession: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const id of evidence) {
    if (id.startsWith("S")) out.add(id.slice(1));
    else if (id.startsWith("obs:") && obsSession.has(id)) out.add(obsSession.get(id)!);
  }
  return out;
}

export function nextLessonId(ledger: Ledger): string {
  const numbers = loadLessons(ledger)
    .values()
    .map(({ path }) => basename(path, ".md").slice(3))
    .filter((digits) => /^\d+$/.test(digits))
    .map(Number)
    .toArray();
  return `ls-${String(numbers.length > 0 ? Math.max(...numbers) + 1 : 1).padStart(3, "0")}`;
}

export function renderLesson(meta: PageMeta, evidence: readonly string[]): string {
  return renderPage(
    meta,
    `\n## Statement\n${str(meta.statement)}\n\n## Evidence\n${evidence.map((id) => `- ${id}\n`).join("")}`,
  );
}

interface JudgedLesson {
  statement?: unknown;
  scope?: unknown;
  evidence?: unknown;
  confidence?: unknown;
  supersedes?: unknown;
  tags?: unknown;
}

interface JudgedEvent {
  text?: unknown;
  kind?: unknown;
  evidence?: unknown;
  files?: unknown;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface ConsolidateSummary {
  created: string[];
  dropped: number;
  superseded: string[];
  /** Created lessons whose status is `confirmed`. */
  confirmed: string[];
  review_events: number;
  /** Events held in the memory ledger because the review ledger was locked. */
  review_events_parked: number;
}

/**
 * Create lesson pages, mark superseded ones, and forward review events when a
 * review ledger is given. The runtime sets every id, status and count.
 */
export function applyConsolidation(
  ledger: Ledger,
  reply: Record<string, unknown>,
  valid: ReadonlySet<string>,
  obsSession: ReadonlyMap<string, string>,
  options: { review?: { ledger: Ledger; project: string }; runId?: string; today?: string } = {},
): ConsolidateSummary {
  const today = options.today ?? todayLocal();
  const existing = loadLessons(ledger);
  const summary: ConsolidateSummary = {
    created: [],
    dropped: 0,
    superseded: [],
    confirmed: [],
    review_events: 0,
    review_events_parked: 0,
  };
  const lessons = Array.isArray(reply.lessons) ? (reply.lessons as JudgedLesson[]) : [];
  for (const lesson of lessons) {
    if (lesson === null || typeof lesson !== "object") continue;
    const evidence = strings(lesson.evidence).filter((id) => valid.has(id));
    const statement = oneLine(lesson.statement);
    if (evidence.length === 0 || statement === "") {
      summary.dropped += 1;
      continue;
    }
    const id = nextLessonId(ledger);
    const sessions = sessionsOf(evidence, obsSession).size;
    const confidence = Number(lesson.confidence);
    const meta: PageMeta = {
      id,
      statement,
      scope: typeof lesson.scope === "string" && SCOPES.has(lesson.scope) ? lesson.scope : "repo",
      status: sessions >= 2 ? "confirmed" : "hypothesis",
      confidence: Math.min(1, Math.max(0, Number.isFinite(confidence) && confidence !== 0 ? confidence : 0.5)).toFixed(
        2,
      ),
      sessions,
      tags: cleanTags(lesson.tags),
      evidence,
      supersedes: [],
      first_seen: today,
      last_seen: today,
      valid_until: "",
    };
    const supersedes: string[] = [];
    for (const old of strings(lesson.supersedes)) {
      const page = existing.get(old);
      if (page === undefined || old === id) continue;
      writeLesson(page.path, { ...page.meta, status: "superseded", valid_until: today, superseded_by: id }, page.body);
      supersedes.push(old);
      summary.superseded.push(old);
    }
    meta.supersedes = supersedes;
    const path = join(ledger.path("lessons"), `${id}.md`);
    writeFileSync(path, renderLesson(meta, evidence));
    existing.set(id, { meta, body: "", path });
    summary.created.push(id);
    if (meta.status === "confirmed") summary.confirmed.push(id);
  }
  if (options.review !== undefined) {
    const events = Array.isArray(reply.review_events) ? (reply.review_events as JudgedEvent[]) : [];
    const delivered = forwardReviewEvents(
      options.review.ledger,
      ledger,
      options.review.project,
      events,
      valid,
      options.runId ?? null,
    );
    summary.review_events = delivered.forwarded;
    summary.review_events_parked = delivered.parked;
  }
  rewriteIndex(ledger);
  return summary;
}

/** Review events built while the review ledger was locked, waiting for a run that gets the lock. */
export const PENDING_REVIEW_FILE = "raw/pending-review-events.jsonl";

/** Evidence-backed findings and corrections from a judge reply, as review events. Deduplicated later by the hash of the text. */
export function buildReviewEvents(
  project: string,
  events: readonly JudgedEvent[],
  valid: ReadonlySet<string>,
  runId: string | null,
): ReviewEvent[] {
  const out: ReviewEvent[] = [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const text = oneLine(event.text);
    const evidence = strings(event.evidence).filter((id) => valid.has(id));
    if (text === "" || evidence.length === 0) continue;
    const obsIds = evidence.filter((id) => id.startsWith("obs:")).map((id) => Number(id.slice(4)));
    const files = strings(event.files)
      .map((file) => oneLine(file, 500))
      .filter((file) => file !== "");
    const forwarded = makeEvent(
      {
        source: MEMORY_SOURCE,
        kind: event.kind === "correction" ? "correction" : "finding",
        project,
        pr: null,
        sha: null,
        author: MEMORY_SOURCE,
        severity: null,
        path: files[0] ?? null,
        line: null,
        text: `${text}\n(evidence: ${evidence.join(", ")})`,
        // The run id rides in url, not author: maintain adds every author to a pattern's reviewers list.
        url: runId === null ? null : `${MEMORY_SOURCE}:run/${runId}`,
        ts: nowIso(),
      },
      createHash("sha1").update(text).digest("hex"),
    );
    if (obsIds[0] !== undefined) forwarded.obs_id = obsIds[0];
    out.push(forwarded);
  }
  return out;
}

/**
 * Append review events to the review ledger's raw layer, where the review
 * loop classifies them on its own next run. Takes the review ledger's lock.
 * A busy ledger parks the events in the memory ledger's
 * `raw/pending-review-events.jsonl` instead of losing them; the next call that
 * gets the lock sends the parked events first and then empties the queue.
 * `appendEvents` deduplicates by hash, so a crash between the two resends
 * nothing twice.
 */
export function deliverReviewEvents(
  review: Ledger,
  memory: Ledger,
  events: readonly ReviewEvent[],
): { forwarded: number; parked: number } {
  const release = review.tryLock();
  if (release === null) {
    appendJsonl(memory.path(PENDING_REVIEW_FILE), events);
    return { forwarded: 0, parked: events.length };
  }
  try {
    const pendingPath = memory.path(PENDING_REVIEW_FILE);
    const parked = readJsonl<ReviewEvent>(pendingPath);
    const fresh = appendEvents(review, [...parked, ...events]);
    if (fresh > 0) review.commit(`learn memory: +${fresh} review events`);
    if (existsSync(pendingPath)) rmSync(pendingPath);
    return { forwarded: fresh, parked: 0 };
  } finally {
    release();
  }
}

/** Build and deliver in one step. Returns how many events reached the review ledger and how many were parked. */
export function forwardReviewEvents(
  review: Ledger,
  memory: Ledger,
  project: string,
  events: readonly JudgedEvent[],
  valid: ReadonlySet<string>,
  runId: string | null,
): { forwarded: number; parked: number } {
  return deliverReviewEvents(review, memory, buildReviewEvents(project, events, valid, runId));
}

/** The lesson's origin as a knowledgebase trigger: a stated preference or a corrected session is a correction. */
function triggerOf(
  meta: PageMeta,
  obsSession: ReadonlyMap<string, string>,
  corrected: ReadonlySet<string>,
): "correction" | "failure" {
  if (list(meta.tags).includes("preference")) return "correction";
  const sessions = sessionsOf(list(meta.evidence), obsSession);
  return [...sessions].some((sid) => corrected.has(sid)) ? "correction" : "failure";
}

export function consolidate(
  ctx: LearnContext,
  source: ClaudeMemSource,
  ledger: Ledger,
  root: string,
  review: Ledger | null,
  trigger = "tick",
): string {
  // Events parked by an earlier run go out as soon as the review ledger is free, even on a night with nothing to consolidate.
  if (review !== null && !ctx.config.dryRun && existsSync(ledger.path(PENDING_REVIEW_FILE)))
    deliverReviewEvents(review, ledger, []);
  const all = loadEpisodes(ledger);
  const pending = unconsolidatedEpisodes(ledger);
  if (pending.length === 0) return "nightly: no unconsolidated episodes";
  const { chosen, failures } = stratify(pending, ctx.config.batch);
  const pairs = pairFailures(failures, all);
  const obsBySid = new Map<string, ObservationRow[]>();
  const obsSessionAll = new Map<string, string>();
  for (const episode of [...chosen, ...pairs.map(([, success]) => success)]) {
    const rows = fetchObs(source, episode.sid);
    obsBySid.set(episode.sid, rows);
    for (const row of rows) obsSessionAll.set(`obs:${row.id}`, sid8(episode.sid).slice(1));
  }
  const { prompt, included } = consolidatePrompt(ctx, ledger, chosen, pairs, obsBySid);
  if (ctx.config.dryRun) {
    ctx.io.out(prompt);
    return `nightly: dry run (${included.length}/${chosen.length} episodes fit, ${pairs.length} pairs, ${tokens(prompt)} prompt tokens)`;
  }
  const runId = `nightly-${todayLocal()}-${nowMs() % 100_000}`;
  const reply = ctx.judge(prompt);
  if (reply === null) {
    const state = readState(ledger);
    saveState(ledger, {
      ...state,
      last_nightly_attempt: nowMs(),
      nightly_failures: (state.nightly_failures ?? 0) + 1,
    });
    appendRun(ledger, { job: "nightly", status: "failed", reason: "no judge output", trigger });
    logLine(ledger, "nightly failed: no judge output");
    return "nightly: judge call failed";
  }
  const includedSids = new Set(included.map((episode) => episode.sid));
  const shown = new Set(included.map((episode) => sid8(episode.sid).slice(1)));
  const obsSession = new Map([...obsSessionAll].filter(([, sid]) => shown.has(sid)));
  const valid = new Set([...obsSession.keys(), ...included.map((episode) => sid8(episode.sid))]);
  const summary = applyConsolidation(ledger, reply, valid, obsSession, {
    review: review === null ? undefined : { ledger: review, project: basename(root) },
    runId,
  });
  markConsolidated(ledger, includedSids, runId);
  const corrected = new Set(
    included.filter((episode) => episode.corrections > 0).map((episode) => sid8(episode.sid).slice(1)),
  );
  const lessons = loadLessons(ledger);
  const proposals: string[] = [];
  const skippedProposals: string[] = [];
  for (const id of summary.confirmed) {
    const page = lessons.get(id);
    if (page === undefined) continue;
    const trig = triggerOf(page.meta, obsSession, corrected);
    const proposal = proposeOrSkip(ctx, ledger, root, page, { runId, createdBy: "learn/consolidator", trigger: trig });
    if ("ref" in proposal) proposals.push(proposal.ref);
    else skippedProposals.push(proposal.skipped);
  }
  const state = readState(ledger);
  const { last_nightly_attempt: _attempt, nightly_failures: _failures, ...withoutBackoff } = state;
  saveState(ledger, { ...withoutBackoff, last_nightly: todayLocal() });
  const log = typeof reply.log === "string" ? reply.log : "";
  const run = {
    job: "nightly",
    id: runId,
    status: "ok",
    trigger,
    episodes: included.map((episode) => episode.sid),
    selected: chosen.length,
    pairs: pairs.length,
    tokens_in: tokens(prompt),
    ...summary,
    proposals,
  };
  const recorded = skippedProposals.length > 0 ? { ...run, proposals_skipped: skippedProposals } : run;
  appendRun(ledger, { ...recorded, log: log.slice(0, 200) });
  logLine(
    ledger,
    `nightly ${runId}: ${included.length}/${chosen.length} episodes, +${summary.created.length} lessons, ${summary.dropped} dropped, ` +
      `${summary.superseded.length} superseded, ${summary.review_events} review events forwarded, ${summary.review_events_parked} parked, ${proposals.length} proposals. ${log}`,
  );
  ledger.commit(`nightly ${runId}: +${summary.created.length} lessons`);
  return `nightly: ${included.length}/${chosen.length} episodes -> +${summary.created.length} lessons, ${summary.review_events} review events`;
}
