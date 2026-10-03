/**
 * The scheduler: the decision table on a fake local clock, a held lock that
 * exits without opening claude-mem, forcing without a job runs every job, and
 * a scheduled tick that discovers a project and never writes inside it.
 */
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../../src/learn/core/ledger.ts";
import { tickLogPath } from "../../src/learn/core/paths.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import {
  ensureMemoryLedger,
  memoryDir,
  readState,
  saveState,
  type MemoryState,
} from "../../src/learn/memory/ledger.ts";
import { readRegistry } from "../../src/learn/memory/registry.ts";
import { decide, type DecideInput, tick } from "../../src/learn/memory/tick.ts";
import { gitRepo, MemFixture, projectScratch, removeProjectScratch, scratch, testContext } from "./helpers.ts";

const NOON = new Date(2026, 8, 18, 12, 0);
const NIGHT = new Date(2026, 8, 18, 2, 10);
const THRESHOLDS = { idleS: 300, reflectTokens: 25_000, nightlyHour: 2 };

function fresh(): MemoryState {
  return { last_reflect: NOON.getTime() - 3_600_000, last_nightly: "2026-09-17", last_weekly: NOON.getTime() };
}

function run(state: MemoryState, now: Date, rest: Partial<DecideInput>): string[] {
  return decide({ state, now, idleS: 0, newTokens: 0, newObs: 0, unconsolidated: 0, ...rest }, THRESHOLDS);
}

describe("decide", () => {
  test("idle with enough new tokens reflects", () =>
    expect(run(fresh(), NOON, { idleS: 600, newTokens: 30_000, newObs: 40 })).toEqual(["reflect"]));

  test("busy does not reflect", () =>
    expect(run(fresh(), NOON, { idleS: 30, newTokens: 30_000, newObs: 40 })).toEqual([]));

  test("a six-hour gap reflects on any observation", () => {
    const state = { ...fresh(), last_reflect: NOON.getTime() - 7 * 3_600_000 };
    expect(run(state, NOON, { idleS: 30, newTokens: 100, newObs: 1 })).toEqual(["reflect"]);
  });

  test("nightly at 02:10 with a new episode", () =>
    expect(run(fresh(), NIGHT, { idleS: 60, unconsolidated: 1 })).toEqual(["nightly"]));

  test("nightly not twice a day", () =>
    expect(run({ ...fresh(), last_nightly: "2026-09-18" }, NIGHT, { idleS: 60, unconsolidated: 1 })).toEqual([]));

  test("a backlog runs nightly at any hour when idle", () =>
    expect(run({ ...fresh(), last_nightly: "2026-09-18" }, NOON, { idleS: 600, unconsolidated: 25 })).toEqual([
      "nightly",
    ]));

  test("weekly when idle and a week has passed", () =>
    expect(run({ ...fresh(), last_weekly: NOON.getTime() - 8 * 86_400_000 }, NOON, { idleS: 600 })).toEqual([
      "weekly",
    ]));

  test("muted runs nothing", () =>
    expect(
      run({ ...fresh(), muted: true, last_weekly: 0 }, NIGHT, {
        idleS: 9999,
        newTokens: 99_999,
        newObs: 9,
        unconsolidated: 30,
      }),
    ).toEqual([]));

  test("force overrides everything, mute included", () => {
    expect(run({ muted: true }, NOON, { force: "all" })).toEqual(["reflect", "nightly", "weekly"]);
    expect(run({}, NOON, { force: "nightly" })).toEqual(["nightly"]);
  });

  test("failed jobs back off exponentially and the reflect token clause respects it", () => {
    const failed = {
      ...fresh(),
      last_reflect_attempt: NOON.getTime() - 30 * 60_000,
      reflect_failures: 1,
      last_nightly_attempt: NOON.getTime() - 30 * 60_000,
      nightly_failures: 1,
    };
    expect(run(failed, NOON, { idleS: 600, newTokens: 30_000, newObs: 40, unconsolidated: 30 })).toEqual([]);
    expect(
      run(failed, new Date(NOON.getTime() + 31 * 60_000), {
        idleS: 600,
        newTokens: 30_000,
        newObs: 40,
        unconsolidated: 30,
      }),
    ).toEqual(["reflect", "nightly"]);
  });
});

function fixtureProject() {
  const dir = scratch();
  const root = gitRepo(join(projectScratch(), "shop"));
  const dbPath = join(dir, "mem.db");
  const mem = new MemFixture(dbPath);
  const now = Date.now();
  mem.session({ sid: "cccc3333-0000", project: "shop", started: now - 86_400_000, completed: now - 86_400_000 + 1000 });
  mem.observation({
    sid: "cccc3333-0000",
    project: "shop",
    type: "discovery",
    title: "found it",
    at: now - 86_400_000 + 500,
  });
  mem.toolUse({ sid: "cccc3333-0000", project: "shop", tool: "Bash", cwd: root, at: now - 86_400_000 + 500 });
  mem.close();
  return { root, ctx: testContext({ cwd: root, env: { AK_LEARN_MEM_DB: dbPath } }) };
}

afterAll(removeProjectScratch);

describe("tick", () => {
  test("an always-failing judge runs once per backoff window and never commits failures", () => {
    const { root, ctx } = fixtureProject();
    const ledger = ensureMemoryLedger(memoryDir(ctx.config, root));
    const start = new Date(2026, 8, 18, 2, 10);
    saveState(ledger, { last_nightly: "2026-09-17", last_weekly: start.getTime() });
    ledger.commit("seed scheduler state");
    try {
      setSystemTime(start);
      expect(tick(ctx)).toBe(0);
      const commits = ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim();
      for (let i = 1; i < 8; i += 1) {
        setSystemTime(new Date(start.getTime() + i * 15 * 60_000));
        expect(tick(ctx)).toBe(0);
      }
      const reflectCalls = ctx.prompts.filter((prompt) => prompt.includes("# learn/reflector")).length;
      const nightlyCalls = ctx.prompts.filter((prompt) => prompt.includes("# learn/consolidator")).length;
      expect(reflectCalls).toBeLessThanOrEqual(2);
      expect(nightlyCalls).toBeLessThanOrEqual(2);
      expect(ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(commits);
      expect(readState(ledger)).toMatchObject({ reflect_failures: reflectCalls, nightly_failures: nightlyCalls });
    } finally {
      setSystemTime();
    }
  });

  test("a held lock exits 0 without opening claude-mem", () => {
    const ctx = testContext();
    mkdirSync(ctx.config.runtimeDir, { recursive: true });
    const release = acquireLock(join(ctx.config.runtimeDir, ".tick.lock"))!;
    try {
      expect(tick(ctx)).toBe(0);
    } finally {
      release();
    }
    expect(ctx.out).toEqual(["tick: another run holds the lock"]);
    expect(existsSync(tickLogPath(ctx.config))).toBe(false);
  });

  test("a missing claude-mem database is logged, not raised", () => {
    const ctx = testContext();
    expect(tick(ctx)).toBe(0);
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).toContain("claude-mem database not found");
  });

  test("force without a job runs every job", () => {
    const { root, ctx } = fixtureProject();
    expect(tick(ctx, { force: true })).toBe(0);
    const jobs = readJsonl<{ job: string }>(join(memoryDir(ctx.config, root), "runs.jsonl")).map((row) => row.job);
    expect(jobs).toEqual(["episodes", "reflect", "nightly", "weekly"]);
    expect(ctx.prompts.length).toBe(2); // reflect and nightly; weekly has no lessons to pair
  });

  test("the scheduled tick discovers the project from tool use and writes nothing inside it", () => {
    const { root, ctx } = fixtureProject();
    const before = readFileSync(join(root, ".git", "index"));
    expect(tick(ctx)).toBe(0);
    expect(Object.values(readRegistry(ctx.config)).map((entry) => entry.root)).toEqual([root]);
    expect(readFileSync(tickLogPath(ctx.config), "utf8")).toContain("shop: episodes +1");
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(before);
  });

  test("a dry run creates no ledger", () => {
    const { root, ctx } = fixtureProject();
    const dry = { ...ctx, config: { ...ctx.config, dryRun: true } };
    expect(tick(dry, { force: true })).toBe(0);
    expect(existsSync(memoryDir(ctx.config, root))).toBe(false);
  });
});
