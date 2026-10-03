import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loopDir } from "../../src/learn/core/paths.ts";
import { run, type RunResult } from "../../src/learn/core/proc.ts";
import { readRegistry } from "../../src/learn/memory/registry.ts";
import { createSetupArea } from "../../src/learn/setup/cli.ts";
import { doctor, doctorChecks } from "../../src/learn/setup/doctor.ts";
import { seed } from "../../src/learn/setup/seed.ts";
import { verify, verifyChecks } from "../../src/learn/setup/verify.ts";
import { MEM_MODE, type SetupDeps, wire } from "../../src/learn/setup/wire.ts";
import { schedule } from "../../src/learn/setup/schedule.ts";
import { parseLearnArgs } from "../../src/learn/core/context.ts";
import { gitRepo, MemFixture, scratch, type TestContext, testContext } from "./helpers.ts";

function fakeDeps(bins: string[], stdout = ""): SetupDeps & { calls: string[][] } {
  const home = scratch("ak-home-");
  const packageRoot = scratch("ak-pkg-");
  const mode = join(packageRoot, "adapters", "observation-source", "claude-mem");
  mkdirSync(mode, { recursive: true });
  writeFileSync(join(mode, `${MEM_MODE}.json`), "{}\n");
  const have = new Set(bins);
  const calls: string[][] = [];
  return {
    home,
    platform: "darwin",
    uid: 501,
    run: (cmd): RunResult => {
      calls.push([...cmd]);
      return { code: 0, stdout, stderr: "", timedOut: false };
    },
    which: (bin) => (have.has(bin) ? `/usr/bin/${bin}` : null),
    ak: ["/opt/bun", "/pkg/src/cli.ts"],
    packageRoot,
    calls,
  };
}

/** A context whose judge command is `judge`, and whose claude-mem lives under the fake home. */
function context(deps: SetupDeps, extra: Record<string, string> = {}): TestContext {
  return testContext({
    env: { AK_LEARN_JUDGE: "judge", CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "", ...extra },
  });
}

describe("setup doctor", () => {
  test("all hard requirements present: exit 0 and nothing changes", () => {
    const deps = fakeDeps(["bun", "git", "judge", "gh"]);
    const ctx = context(deps);
    expect(doctor(ctx, deps)).toBe(0);
    expect(ctx.out.at(-1)).toBe("\nAll hard requirements present.");
    expect(deps.calls).toEqual([["/usr/bin/gh", "auth", "status"]]);
    expect(existsSync(ctx.config.configDir)).toBe(false);
  });

  test("a missing judge blocks; a missing claude-mem only narrows", () => {
    const deps = fakeDeps(["bun", "git"]);
    const ctx = context(deps);
    const checks = doctorChecks(ctx, deps);
    expect(checks.filter((c) => !c.ok).map((c) => [c.name, c.hard])).toEqual([
      ["judge (judge)", true],
      ["claude-mem db", false],
      ["claude-mem worker script", false],
      ["gh authenticated", false],
    ]);
    expect(doctor(ctx, deps)).toBe(1);
    expect(ctx.out.at(-1)).toBe("\nBLOCKED: judge (judge)");
  });

  test("a judge given as a path must exist", () => {
    const deps = fakeDeps(["bun", "git"]);
    const judge = join(scratch(), "judge.sh");
    writeFileSync(judge, "");
    expect(doctor(context(deps, { AK_LEARN_JUDGE: judge }), deps)).toBe(0);
    expect(doctor(context(deps, { AK_LEARN_JUDGE: `${judge}.missing` }), deps)).toBe(1);
  });

  test("checks the scheduled default judge's auth without making a judge call", () => {
    const deps = fakeDeps(["bun", "git", "claude"], '{"loggedIn":true}\n');
    const ctx = testContext({ env: { CLAUDE_CONFIG_DIR: join(deps.home, ".claude"), HOME: deps.home } });
    expect(doctor(ctx, deps)).toBe(0);
    expect(ctx.out).toContain("  scheduled judge auth      OK       soft  logged in");
    expect(ctx.prompts).toEqual([]);
    expect(deps.calls).toContainEqual(["/usr/bin/claude", "auth", "status"]);
  });

  test("a live judge probe runs only behind the explicit flag", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const ctx = testContext({
      env: { AK_LEARN_JUDGE: "judge", CLAUDE_MEM_DATA_DIR: join(deps.home, ".claude-mem"), CODEX_HOME: "" },
      replies: [{ ok: true }],
    });
    expect(doctor(ctx, deps)).toBe(0);
    expect(ctx.prompts).toEqual([]);
    expect(doctor(ctx, deps, { liveJudge: true })).toBe(0);
    expect(ctx.prompts).toHaveLength(1);
  });
});

describe("setup seed", () => {
  test("registers the repo, creates three ledgers, calls no judge and writes nothing in the repo", () => {
    const ctx = testContext();
    const repo = gitRepo(join(scratch(), "repo"));
    mkdirSync(join(repo, "sub"));
    expect(seed(ctx, join(repo, "sub"), { skipGithub: true })).toBe(0);
    for (const loop of ["review", "memory", "skills"] as const)
      expect(existsSync(join(loopDir(ctx.config, repo, loop), ".git"))).toBe(true);
    expect(Object.values(readRegistry(ctx.config)).map((entry) => entry.root)).toEqual([repo]);
    expect(ctx.prompts).toEqual([]);
    expect(ctx.out.some((line) => line.startsWith("dry ingest: "))).toBe(true);
    expect(run(["git", "status", "--porcelain"], { cwd: repo }).stdout).toBe("");
  });

  test("outside a repository it refuses", () => {
    const ctx = testContext();
    expect(seed(ctx, scratch(), { skipGithub: true })).toBe(1);
    expect(ctx.err[0]).toContain("is not inside a git repository");
  });

  test("the CLI requires --repo", () => {
    const ctx = testContext();
    expect(createSetupArea(() => fakeDeps([])).verbs.seed!.run(parseLearnArgs([]), ctx)).toBe(2);
  });
});

describe("setup verify", () => {
  test("a fresh machine fails every check it can make", () => {
    const deps = fakeDeps(["bun", "git"]);
    const ctx = context(deps);
    const failed = verifyChecks(ctx, deps)
      .filter((r) => !r.ok)
      .map((r) => r.label);
    expect(failed).toEqual([
      "claude SessionStart hook",
      "claude Stop hook",
      "launchd unit written",
      "launchd job loaded",
      "seeded projects",
      "judge command resolvable",
    ]);
    expect(verify(ctx, deps)).toBe(1);
    expect(ctx.out.at(-1)).toBe("\n6 checks failed");
  });

  test("after wire, schedule and seed everything passes", () => {
    const deps = fakeDeps(["bun", "git", "judge"], "123\t0\tdev.agent-kit.learn\n");
    const memDb = join(deps.home, ".claude-mem", "claude-mem.db");
    mkdirSync(join(deps.home, ".claude-mem"), { recursive: true });
    new MemFixture(memDb).close();
    const ctx = context(deps, { AK_LEARN_MEM_DB: memDb });
    const repo = gitRepo(join(scratch(), "repo"));
    wire(ctx, deps);
    schedule(ctx, deps);
    seed(ctx, repo, { skipGithub: true });
    ctx.out.length = 0;

    const results = verifyChecks(ctx, deps);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.label)).toContain("claude-mem observation budget");
    expect(results.map((r) => r.label)).toContain(`skills ledger (${repo})`);
    expect(verify(ctx, deps, repo)).toBe(0);
    expect(ctx.out.at(-1)).toBe("\nall checks passed");
    expect(deps.calls.every((call) => call[0] === "launchctl" && call[1] === "list")).toBe(true);
  });

  test("a hook wired twice by hand is reported, not accepted", () => {
    const deps = fakeDeps(["bun", "git", "judge"]);
    const ctx = context(deps);
    mkdirSync(ctx.config.configDir, { recursive: true });
    const stop = { hooks: [{ type: "command", command: "ak learn hook stop" }] };
    writeFileSync(join(ctx.config.configDir, "settings.json"), JSON.stringify({ hooks: { Stop: [stop, stop] } }));
    const result = verifyChecks(ctx, deps).find((r) => r.label === "claude Stop hook")!;
    expect(result).toEqual({ label: "claude Stop hook", ok: false, detail: "2 entries" });
  });
});
