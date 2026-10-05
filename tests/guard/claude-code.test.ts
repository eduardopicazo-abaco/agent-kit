import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli.ts";
import { resolveLink, runGuard } from "../../src/guard/cli.ts";
import { UNJUDGEABLE } from "../../src/guard/evaluate.ts";
import { decodeClaudeCode, encodeClaudeCode, type LinkResolver } from "../../src/guard/hosts/claude-code.ts";

/**
 * CS-11's acceptance criteria (research/briefs/constitution-support-plan.md):
 * the Claude Code replay suite. Each case under
 * tests/fixtures/guard/claude-code/ is a `.stdin` file, the exact bytes a
 * PreToolUse command hook reads on claude 2.1.288, and an `.expected.json`
 * with the decision. The payloads are invented in that version's shape; the
 * workspace they name, /work/repo, is a path no test creates, and the links a
 * case declares stand in for the filesystem, so a replay reads nothing but
 * its fixture and the example policy.
 */
const ROOT = join(import.meta.dir, "..", "..");
const CASES = join(ROOT, "tests", "fixtures", "guard", "claude-code");
const POLICY = "tests/fixtures/guard/policy.yaml";
const HOOK = ["hook", "pre-tool-use", "--policy", POLICY];
const ENV = { CLAUDE_PROJECT_DIR: "/work/repo", HOME: "/home/dev" };
const RECEIPTS = join(ROOT, "research", "host-facts", "2026-10-03");

interface Expected {
  why: string;
  decision: "allow" | "deny" | "fail-open";
  rule?: string;
  links?: Record<string, string>;
  when_answered?: { decision: "allow" | "deny"; rule?: string };
  receipt?: string;
}

interface HookOutput {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };
}

const ajv = new Ajv2020({ strict: false });
const DECISION = { enum: ["allow", "deny"] };
const expectedFile = ajv.compile<Expected>({
  type: "object",
  additionalProperties: false,
  required: ["why", "decision"],
  properties: {
    why: { type: "string", minLength: 1 },
    decision: { enum: ["allow", "deny", "fail-open"] },
    rule: { type: "string", minLength: 1 },
    links: { type: "object", additionalProperties: { type: "string" } },
    when_answered: {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: { decision: DECISION, rule: { type: "string" } },
    },
    receipt: { type: "string", pattern: "^(claude-code|codex)-[0-9]+$" },
  },
});
/** Exactly the deny Claude Code reads (claude-code-1): one key, the event, the decision and a reason. */
const hookOutput = ajv.compile<HookOutput>({
  type: "object",
  additionalProperties: false,
  required: ["hookSpecificOutput"],
  properties: {
    hookSpecificOutput: {
      type: "object",
      additionalProperties: false,
      required: ["hookEventName", "permissionDecision", "permissionDecisionReason"],
      properties: {
        hookEventName: { const: "PreToolUse" },
        permissionDecision: { const: "deny" },
        permissionDecisionReason: { type: "string", minLength: 1 },
      },
    },
  },
});

interface Case {
  name: string;
  stdin: string;
  expected: Expected;
}

function loadCases(): Case[] {
  return readdirSync(CASES)
    .filter((f) => f.endsWith(".stdin"))
    .toSorted()
    .map((f) => {
      const name = f.slice(0, -".stdin".length);
      const expected: unknown = JSON.parse(readFileSync(join(CASES, `${name}.expected.json`), "utf8"));
      if (!expectedFile(expected)) throw new Error(`${name}.expected.json: ${JSON.stringify(expectedFile.errors)}`);
      return { name, stdin: readFileSync(join(CASES, f), "utf8"), expected };
    });
}

const ALL = loadCases();

function fixtureLinks(links: Record<string, string> = {}): LinkResolver {
  return (path) => links[path] ?? null;
}

interface Run {
  code: number;
  out: string[];
  err: string[];
}

function replay(stdin: string, links?: Record<string, string>, argv: string[] = HOOK): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runGuard(argv, {
    cwd: ROOT,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    stdin,
    env: ENV,
    resolve: fixtureLinks(links),
  });
  return { code, out, err };
}

/** The decision the hook's answer carries, read the way Claude Code reads it. */
function decisionOf(run: Run): { decision: "allow" } | { decision: "deny"; reason: string } {
  expect(run.code).toBe(0);
  if (run.out.length === 0) return { decision: "allow" };
  expect(run.out).toHaveLength(1);
  const parsed: unknown = JSON.parse(run.out[0] ?? "");
  if (!hookOutput(parsed)) throw new Error(`not a PreToolUse deny: ${run.out[0]}`);
  return { decision: "deny", reason: parsed.hookSpecificOutput.permissionDecisionReason };
}

function expectDecision(run: Run, decision: "allow" | "deny", rule: string | undefined): void {
  const found = decisionOf(run);
  expect(found.decision).toBe(decision);
  if (found.decision === "deny") expect(found.reason.startsWith(`agent-kit guard [${rule}]: `)).toBe(true);
}

describe("the replay fixtures", () => {
  test("every payload has an expected file and every expected file a payload", () => {
    const files = readdirSync(CASES);
    const stdins = files.filter((f) => f.endsWith(".stdin")).map((f) => f.slice(0, -".stdin".length));
    const expecteds = files
      .filter((f) => f.endsWith(".expected.json"))
      .map((f) => f.slice(0, -".expected.json".length));
    expect(expecteds.toSorted()).toEqual(stdins.toSorted());
    expect(stdins.length).toBeGreaterThan(0);
  });

  test("each expected file names what its decision needs, and its receipt exists", () => {
    const receipts = readdirSync(RECEIPTS);
    for (const { name, expected } of ALL) {
      if (expected.decision === "deny") expect(expected.rule, name).toBeString();
      if (expected.decision === "fail-open") expect(expected.when_answered, name).toBeDefined();
      if (expected.receipt !== undefined) {
        expect(
          receipts.some((f) => f.startsWith(`${expected.receipt}-`)),
          name,
        ).toBe(true);
      }
    }
  });

  test("the bypass fixtures the plan names are all present", () => {
    const names = new Set(ALL.map((c) => c.name));
    for (const name of [
      "bypass-git-dash-C-push-force",
      "bypass-interpreter-writes-ci-config",
      "bypass-interpreter-writes-test",
      "bypass-symlink-into-tests",
      "bypass-write-through-symlink",
      "bypass-rename-into-tests",
      "timeout-fail-open",
      "unjudgeable-not-json",
      "unjudgeable-no-tool-name",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

describe("every replay payload runs decoder, evaluator and encoder to the expected decision", () => {
  for (const { name, stdin, expected } of ALL) {
    test(name, () => {
      const run = replay(stdin, expected.links);
      if (expected.decision === "fail-open") {
        // Answered in time, the guard denies; the fail-open is the host's, tested below.
        expectDecision(run, expected.when_answered?.decision ?? "deny", expected.when_answered?.rule);
      } else {
        expectDecision(run, expected.decision, expected.rule);
      }
      expect(run.err).toEqual([]);
    });
  }
});

describe("the encoder", () => {
  test("a deny is permissionDecision deny with the rule and reason, on stdout, exit 0", () => {
    const response = encodeClaudeCode({ decision: "deny", rule: "protected.tests", reason: "Tests are protected" });
    expect(response.exit).toBe(0);
    expect(response.stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "agent-kit guard [protected.tests]: Tests are protected",
      },
    });
  });

  test("an allow is silence, never a permissionDecision that would skip the user's prompt", () => {
    expect(encodeClaudeCode({ decision: "allow" })).toEqual({ stdout: "", exit: 0 });
  });

  test("no replay answer exits 2 or carries allow or ask", () => {
    for (const { name, stdin, expected } of ALL) {
      const run = replay(stdin, expected.links);
      expect(run.code, name).toBe(0);
      for (const line of run.out) {
        expect(line, name).not.toContain('"allow"');
        expect(line, name).not.toContain('"ask"');
      }
    }
  });
});

type ToolInput = Record<string, string | number> | string;
const BASE = { session_id: "s-1", cwd: "/work/repo", hook_event_name: "PreToolUse" };

function rawCall(tool: string, toolInput: ToolInput): string {
  return JSON.stringify({ ...BASE, tool_name: tool, tool_input: toolInput });
}

function decode(tool: string, toolInput: ToolInput): ReturnType<typeof decodeClaudeCode> {
  return decodeClaudeCode(rawCall(tool, toolInput));
}

const aliasIntoTests: LinkResolver = (p) => (p === "/work/repo/src/a.ts" ? "/work/repo/tests/a.test.ts" : null);

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("the decoder", () => {
  test("maps each judged tool to its normalized action", () => {
    expect(decode("Bash", { command: "ls" })).toMatchObject({
      kind: "judge",
      action: { kind: "shell", argv: ["bash", "-c", "ls"] },
      cwd: "/work/repo",
      sessionId: "s-1",
    });
    expect(decode("Read", { file_path: "/a" })).toMatchObject({ action: { kind: "read", paths: ["/a"] } });
    expect(decode("Grep", { pattern: "x", path: "/a" })).toMatchObject({ action: { kind: "read", paths: ["/a"] } });
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      expect(decode(tool, { file_path: "/a" })).toMatchObject({ action: { kind: "write", paths: ["/a"] } });
    }
    expect(decode("NotebookEdit", { notebook_path: "/n.ipynb" })).toMatchObject({
      action: { kind: "write", paths: ["/n.ipynb"] },
    });
  });

  test("passes a tool that names no file, and Grep with no path", () => {
    expect(decode("WebSearch", { query: "x" })).toEqual({ kind: "pass", tool: "WebSearch" });
    expect(decode("mcp__files__write", { path: "tests/x" })).toEqual({ kind: "pass", tool: "mcp__files__write" });
    expect(decode("Grep", { pattern: "x" })).toEqual({ kind: "pass", tool: "Grep" });
  });

  test("adds a link's target after the path, and leaves a shell action alone", () => {
    const resolve = aliasIntoTests;
    expect(decodeClaudeCode(rawCall("Edit", { file_path: "src/a.ts" }), { resolve })).toMatchObject({
      action: { kind: "write", paths: ["src/a.ts", "/work/repo/tests/a.test.ts"] },
    });
    expect(decodeClaudeCode(rawCall("Bash", { command: "echo > src/a.ts" }), { resolve })).toMatchObject({
      action: { kind: "shell", argv: ["bash", "-c", "echo > src/a.ts"] },
    });
  });

  test("denies what it cannot read as unjudgeable", () => {
    for (const stdin of ["", "{", "null", "[]", '"Bash"', JSON.stringify({ ...BASE, tool_name: "" })]) {
      const decoded = decodeClaudeCode(stdin);
      expect(decoded.kind, stdin).toBe("deny");
      if (decoded.kind === "deny") expect(decoded.verdict.rule).toBe(UNJUDGEABLE);
    }
    expect(decode("Read", "not an object")).toMatchObject({ kind: "deny" });
    expect(decode("Grep", { pattern: "x", path: 3 })).toMatchObject({ kind: "deny" });
  });
});

describe("resolveLink", () => {
  test("follows a linked file and a new file under a linked directory, and is null where nothing is linked", () => {
    const work = mkdtempSync(join(tmpdir(), "ak-guard-link-"));
    try {
      mkdirSync(join(work, "tests"));
      mkdirSync(join(work, "src"));
      writeFileSync(join(work, "tests", "real.test.ts"), "");
      symlinkSync(join(work, "tests", "real.test.ts"), join(work, "src", "alias.ts"));
      symlinkSync(join(work, "tests"), join(work, "src", "linked"));
      const real = resolveLink(work) ?? work;
      expect(resolveLink(join(work, "src", "alias.ts"))).toBe(join(real, "tests", "real.test.ts"));
      expect(resolveLink(join(work, "src", "linked", "new.test.ts"))).toBe(join(real, "tests", "new.test.ts"));
      expect(resolveLink(join(real, "src", "plain.ts"))).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("ak guard hook", () => {
  const payload = readFileSync(join(CASES, "deny-bash-rm-recursive-force.stdin"), "utf8");

  test("runCli dispatches to it with the stdin payload", () => {
    const captured = captureIo();
    const code = runCli(["guard", ...HOOK], { cwd: ROOT, io: captured.io, stdin: payload });
    expect(code).toBe(0);
    expect(captured.out[0]).toContain("destructive.rm-recursive-force");
  });

  test("without a verb it prints its usage and exits 2", () => {
    const captured = captureIo();
    expect(runCli(["guard"], { cwd: ROOT, io: captured.io })).toBe(2);
    expect(captured.err.join("\n")).toContain("ak guard hook pre-tool-use");
  });

  test("an event or host it cannot answer in is a non-blocking exit 1, never 2", () => {
    expect(replay(payload, undefined, ["hook", "post-tool-use", "--policy", POLICY]).code).toBe(1);
    expect(replay(payload, undefined, [...HOOK, "--host", "elsewhere"]).code).toBe(1);
  });

  test("a policy it cannot load, or a missing --policy, denies a judged call", () => {
    const missing = replay(payload, undefined, [
      "hook",
      "pre-tool-use",
      "--policy",
      "tests/fixtures/guard/absent.yaml",
    ]);
    expectDecision(missing, "deny", UNJUDGEABLE);
    expect(missing.out[0]).toContain("guard.policy-missing");
    expectDecision(replay(payload, undefined, ["hook", "pre-tool-use"]), "deny", UNJUDGEABLE);
    expectDecision(replay(payload, undefined, [...HOOK, "--root"]), "deny", UNJUDGEABLE);
  });

  test("a call it does not judge passes even without a policy", () => {
    const webfetch = readFileSync(join(CASES, "allow-webfetch-not-judged.stdin"), "utf8");
    expectDecision(replay(webfetch, undefined, ["hook", "pre-tool-use"]), "allow", undefined);
  });

  test("--root overrides the project directory the policy's globs are relative to", () => {
    const write = readFileSync(join(CASES, "deny-write-vendor.stdin"), "utf8");
    expectDecision(replay(write, undefined, [...HOOK, "--root", "/work"]), "allow", undefined);
  });
});

/** The real entrypoint, stdin and all, as Claude Code runs it. */
function spawnHook(): ReturnType<typeof spawn> {
  return spawn(process.execPath, [join(ROOT, "src", "cli.ts"), "guard", ...HOOK], {
    cwd: ROOT,
    env: { ...process.env, ...ENV },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

describe("the hook process", () => {
  test("reads the payload from stdin and answers a deny on stdout with exit 0", async () => {
    const child = spawnHook();
    const stdout = collect(child.stdout);
    const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    child.stdin?.end(readFileSync(join(CASES, "bypass-git-dash-C-push-force.stdin")));
    expect(await done).toBe(0);
    expect(stdout()).toContain('"permissionDecision":"deny"');
    expect(stdout()).toContain("destructive.git-push-force");
  }, 30_000);

  test("a hook that has not answered when the host's timeout fires has printed nothing, so the call runs", async () => {
    // claude-code-1: a timed-out command hook does not block the tool call.
    // The case's expected file records the fail-open; this shows the guard
    // leaves no partial answer behind for the host to read as a deny.
    const timeout = ALL.find((c) => c.name === "timeout-fail-open");
    expect(timeout?.expected.decision).toBe("fail-open");
    expect(existsSync(join(RECEIPTS, "claude-code-1-hook-failures.md"))).toBe(true);
    const child = spawnHook();
    const stdout = collect(child.stdout);
    const done = new Promise<NodeJS.Signals | null>((resolve) => child.on("close", (_code, signal) => resolve(signal)));
    // Claude Code closes stdin once the payload is written; one that never closes stands for a hook still running.
    child.stdin?.write(timeout?.stdin ?? "");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    child.kill("SIGTERM");
    expect(await done).toBe("SIGTERM");
    expect(stdout()).toBe("");
  }, 30_000);
});
