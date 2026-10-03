/**
 * The memory loop's scheduler. Every tick: take the runtime-wide lock,
 * discover projects from claude-mem, and for each project active in the last
 * seven days record new episodes, then run whichever of reflect, nightly and
 * weekly are due. Failures are logged, never raised.
 *
 * The scheduled path uses stat only. It never spawns git in a repository and
 * never opens a file inside one: under a macOS scheduler that open blocks on
 * the privacy prompt and ignores every timeout. Git runs only in the ledgers,
 * which live under the config directory.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { acquireLock, Ledger } from "../core/ledger.ts";
import { tickLogPath } from "../core/paths.ts";
import { nowIso, nowMs, todayLocal } from "../core/store.ts";
import { loadEvents } from "../review/events.ts";
import { reviewLedger, reviewLedgerDir } from "../review/ledger.ts";
import { ClaudeMemSource } from "../sources/claude-mem.ts";
import { consolidate } from "./consolidate.ts";
import { deep } from "./deep.ts";
import { buildEpisodes, type EpisodeEvent, unconsolidatedEpisodes } from "./episodes.ts";
import { appendRun, ensureMemoryLedger, logLine, type MemoryState, memoryDir, readState } from "./ledger.ts";
import { reflect } from "./reflect.ts";
import { discoverProjects, discoverySince, readRegistry } from "./registry.ts";

export type Job = "reflect" | "nightly" | "weekly";
export const JOBS: readonly Job[] = ["reflect", "nightly", "weekly"];

export const ACTIVE_DAYS = 7;
export const REFLECT_MAX_GAP_MS = 6 * 3600 * 1000;
export const NIGHTLY_BACKLOG = 25;
export const WEEK_MS = 7 * 86_400_000;
export const FAILURE_BACKOFF_MIN_MS = 3_600_000;
export const FAILURE_BACKOFF_MAX_MS = 24 * FAILURE_BACKOFF_MIN_MS;

export interface DecideInput {
  state: MemoryState;
  /** The machine's local clock: the nightly hour and the calendar day are local. */
  now: Date;
  idleS: number;
  newTokens: number;
  newObs: number;
  unconsolidated: number;
  /** `all` or one job forces it, even on a muted project. */
  force?: Job | "all" | null;
}

export interface Thresholds {
  idleS: number;
  reflectTokens: number;
  nightlyHour: number;
}

function backoffElapsed(state: MemoryState, job: "reflect" | "nightly", now: number): boolean {
  const failures = job === "reflect" ? state.reflect_failures : state.nightly_failures;
  const attempted = job === "reflect" ? state.last_reflect_attempt : state.last_nightly_attempt;
  if (!failures || attempted === undefined) return true;
  const delay = Math.min(FAILURE_BACKOFF_MIN_MS * 2 ** (failures - 1), FAILURE_BACKOFF_MAX_MS);
  return now - attempted >= delay;
}

/**
 * Which jobs are due. Pure.
 *
 * | Job | Due when |
 * |---|---|
 * | reflect | idle and new discovery tokens reach the threshold, or any new observation 6h after the last reflect |
 * | nightly | past the nightly hour, not yet run today, one unconsolidated episode; or a backlog of 25 while idle |
 * | weekly | idle and a week since the last |
 */
export function decide(input: DecideInput, thresholds: Thresholds): Job[] {
  if (input.force) return input.force === "all" ? [...JOBS] : [input.force];
  if (input.state.muted) return [];
  const due: Job[] = [];
  const idle = input.idleS >= thresholds.idleS;
  const now = input.now.getTime();
  const lastReflect = input.state.last_reflect ?? 0;
  if (
    backoffElapsed(input.state, "reflect", now) &&
    ((idle && input.newTokens >= thresholds.reflectTokens) ||
      (input.newObs > 0 && now - lastReflect >= REFLECT_MAX_GAP_MS))
  )
    due.push("reflect");
  const today = todayLocal(input.now);
  if (
    backoffElapsed(input.state, "nightly", now) &&
    ((input.now.getHours() >= thresholds.nightlyHour &&
      (input.state.last_nightly ?? "") < today &&
      input.unconsolidated >= 1) ||
      (input.unconsolidated >= NIGHTLY_BACKLOG && idle))
  ) {
    due.push("nightly");
  }
  if (idle && now - (input.state.last_weekly ?? 0) >= WEEK_MS) due.push("weekly");
  return due;
}

/** The review ledger's raw events, when the review loop has one. Never creates it. */
function reviewEvents(ctx: LearnContext, root: string): EpisodeEvent[] {
  const ledger = new Ledger(reviewLedgerDir(ctx.config, root));
  return ledger.initialized ? loadEvents(ledger) : [];
}

/**
 * One project's episodes and due jobs. Takes the memory ledger's lock; a
 * concurrent run on the same project returns without doing anything.
 */
export function runProject(
  ctx: LearnContext,
  source: ClaudeMemSource,
  root: string,
  memProject: string,
  options: { job?: Job | "all"; force?: boolean } = {},
): string[] {
  const dryRun = ctx.config.dryRun;
  const ledger = dryRun ? new Ledger(memoryDir(ctx.config, root)) : ensureMemoryLedger(memoryDir(ctx.config, root));
  const release = dryRun ? () => undefined : ledger.tryLock();
  if (release === null) return ["another run holds this project's memory ledger"];
  try {
    const out: string[] = [];
    try {
      const fresh = buildEpisodes(source, ledger, memProject, reviewEvents(ctx, root), { dryRun });
      out.push(`episodes +${fresh.length}`);
      if (fresh.length > 0 && !dryRun) {
        appendRun(ledger, { job: "episodes", status: "ok", new: fresh.map((episode) => episode.sid) });
        ledger.commit(`episodes +${fresh.length}`);
      }
    } catch (error) {
      out.push(`episodes failed: ${(error as Error).message}`);
      if (!dryRun) logLine(ledger, `episodes failed: ${(error as Error).message}`);
    }
    const state = readState(ledger);
    const lastActivity = source.lastActivityMs(memProject);
    if (!lastActivity)
      return [...out, `no claude-mem observations under project '${memProject}'; check the folder basename matches`];
    const idleS = (nowMs() - lastActivity) / 1000;
    const { tokens: newTokens, count: newObs } = source.newTokensSince(memProject, state.last_obs_id_reflected ?? 0);
    const unconsolidated = unconsolidatedEpisodes(ledger).length;
    const force = options.force === true ? (options.job ?? "all") : null;
    let due = decide({ state, now: new Date(), idleS, newTokens, newObs, unconsolidated, force }, ctx.config);
    if (options.job !== undefined && options.force !== true)
      due = due.filter((job) => options.job === "all" || options.job === job);
    const dueText = due.length > 0 ? due.join(",") : "none";
    out.push(
      `idle ${Math.floor(idleS)}s new_tokens ${newTokens} new_obs ${newObs} unconsolidated ${unconsolidated} due ${dueText}`,
    );
    const trigger = options.force === true ? "force" : "tick";
    const existingReview = new Ledger(reviewLedgerDir(ctx.config, root));
    const runners: Record<Job, () => string> = {
      reflect: () => reflect(ctx, source, ledger, memProject, trigger),
      // Forwarding findings seeds the review ledger when it is missing; compaction only touches one that exists.
      nightly: () => consolidate(ctx, source, ledger, root, dryRun ? null : reviewLedger(ctx.config, root), trigger),
      weekly: () => deep(ctx, ledger, root, existingReview.initialized ? existingReview : null, trigger),
    };
    for (const job of JOBS) {
      if (!due.includes(job)) continue;
      try {
        out.push(runners[job]());
      } catch (error) {
        const err = error as Error;
        out.push(`${job} failed: ${err.message}`);
        if (!dryRun)
          logLine(ledger, `${job} failed: ${err.message}\n\`\`\`\n${(err.stack ?? "").slice(-1500)}\n\`\`\``);
      }
    }
    return out;
  } finally {
    release();
  }
}

function tickLog(ctx: LearnContext, line: string): void {
  ctx.io.out(line);
  if (ctx.config.dryRun) return;
  const path = tickLogPath(ctx.config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
}

/**
 * The scheduled tick over every registered project active in the last seven
 * days, or over `only` (a main repo root already resolved by the caller).
 * Returns 0 in every case, including a held lock: the loser exits quietly.
 */
export function tick(ctx: LearnContext, options: { only?: string; job?: Job | "all"; force?: boolean } = {}): number {
  mkdirSync(ctx.config.runtimeDir, { recursive: true });
  const release = acquireLock(join(ctx.config.runtimeDir, ".tick.lock"));
  if (release === null) {
    ctx.io.out("tick: another run holds the lock");
    return 0;
  }
  try {
    const source = ClaudeMemSource.open(ctx.config.memDb);
    if (source === null) {
      tickLog(ctx, `${nowIso()} tick: claude-mem database not found at ${ctx.config.memDb}`);
      return 0;
    }
    try {
      tickLog(ctx, `== ${nowIso()} tick${ctx.config.dryRun ? " DRY RUN" : ""}`);
      const registry =
        options.only === undefined
          ? discoverProjects(ctx.config, source.toolUseCwds(discoverySince()))
          : readRegistry(ctx.config);
      const cutoff = nowMs() - ACTIVE_DAYS * 86_400_000;
      for (const entry of Object.values(registry)) {
        if (options.only !== undefined && entry.root !== options.only) continue;
        if (options.only === undefined && source.lastActivityMs(entry.mem_project) < cutoff) continue;
        const name = entry.mem_project || basename(entry.root);
        let lines: string[];
        try {
          lines = runProject(ctx, source, entry.root, entry.mem_project, { job: options.job, force: options.force });
        } catch (error) {
          lines = [`failed: ${(error as Error).message}`];
        }
        for (const line of lines) tickLog(ctx, `${name}: ${line}`);
      }
    } finally {
      source.close();
    }
  } catch (error) {
    ctx.io.err(`tick failed: ${(error as Error).message}`);
  } finally {
    release();
  }
  return 0;
}
