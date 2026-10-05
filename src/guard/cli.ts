/**
 * `ak guard` — the opt-in guard runtime (docs/decisions/0009-constitution-support.md, Decision 2).
 *
 * `ak guard hook pre-tool-use --policy <file>` is the entry a host's hook
 * configuration calls. It reads the host payload from stdin, decodes it,
 * judges it with the one evaluator and encodes the verdict for the host. Every
 * answer it can give is exit 0: a deny is JSON on stdout and an allow is
 * silence. A call it cannot judge, including one it cannot judge because the
 * policy did not load or the guard itself threw, is denied. Only a wiring
 * fault it cannot answer in any host's format (an unknown event or host)
 * exits 1, which both hosts treat as a non-blocking error.
 *
 * The hook is not wired by anything yet: `ak guard setup` and the `guard`
 * profile are a later ticket, and no core bundle carries it.
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import type { GuardContext } from "./action.ts";
import { evaluate, UNJUDGEABLE, type GuardVerdict } from "./evaluate.ts";
import { decodeClaudeCode, encodeClaudeCode, type HookResponse, type LinkResolver } from "./hosts/claude-code.ts";
import { loadGuardPolicy } from "./policy.ts";

export interface GuardIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface RunGuardOptions {
  cwd: string;
  io: GuardIo;
  /** The host payload, read from stdin by the entrypoint. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** How a file tool's path is followed through symlinks; the filesystem when absent. */
  resolve?: LinkResolver;
}

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

const USAGE = [
  "ak guard — the opt-in guard runtime (ADR-0009)",
  "",
  "  ak guard hook pre-tool-use --policy <file> [--host claude-code] [--root <dir>]",
  "      judge one host tool call read from stdin; a deny is JSON on stdout, exit 0",
];

const HOSTS = new Set(["claude-code"]);
const EVENTS = new Set(["pre-tool-use"]);

interface HookArgs {
  event: string | undefined;
  host: string;
  policy: string | undefined;
  root: string | undefined;
  bad: string[];
}

function parseHookArgs(argv: readonly string[]): HookArgs {
  const args: HookArgs = { event: undefined, host: "claude-code", policy: undefined, root: undefined, bad: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--host" || token === "--policy" || token === "--root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        args.bad.push(`${token} needs a value`);
        continue;
      }
      i += 1;
      if (token === "--host") args.host = value;
      else if (token === "--policy") args.policy = value;
      else args.root = value;
    } else if (token.startsWith("--")) {
      args.bad.push(`unknown flag ${token}`);
    } else if (args.event === undefined) {
      args.event = token;
    } else {
      args.bad.push(`unexpected argument ${token}`);
    }
  }
  return args;
}

/** The host's hook payload on stdin, read only for `ak guard hook …`; `argv` is the whole command line after `ak`. */
export function readGuardStdin(argv: readonly string[]): string | undefined {
  if (argv[0] !== "guard" || argv[1] !== "hook" || process.stdin.isTTY) return undefined;
  try {
    return readFileSync(0, "utf8");
  } catch {
    return undefined;
  }
}

/** `argv` is everything after `ak guard`. */
export function runGuard(argv: readonly string[], options: RunGuardOptions): number {
  if (argv[0] !== "hook") {
    if (argv[0] !== undefined) options.io.err(`ak guard: unknown verb ${argv[0]}`);
    for (const line of USAGE) options.io.err(line);
    return 2;
  }
  const args = parseHookArgs(argv.slice(1));
  if (args.event === undefined || !EVENTS.has(args.event)) {
    options.io.err(`ak guard hook: unknown event ${args.event ?? "(none)"}; the guard answers pre-tool-use`);
    return 1;
  }
  if (!HOSTS.has(args.host)) {
    options.io.err(`ak guard hook: unknown host ${args.host}; the guard answers claude-code`);
    return 1;
  }
  const response = answer(args, options);
  if (response.stdout !== "") options.io.out(response.stdout.trimEnd());
  return response.exit;
}

function answer(args: HookArgs, options: RunGuardOptions): HookResponse {
  try {
    return encodeClaudeCode(judge(args, options));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return encodeClaudeCode(cannotJudge(`the guard failed (${message.split("\n")[0]})`));
  }
}

function cannotJudge(why: string): GuardVerdict {
  return { decision: "deny", rule: UNJUDGEABLE, reason: `The guard cannot judge this call: ${why}.` };
}

function judge(args: HookArgs, options: RunGuardOptions): GuardVerdict {
  if (args.bad.length > 0) return cannotJudge(`the hook is wired with bad arguments (${args.bad.join("; ")})`);
  const decoded = decodeClaudeCode(options.stdin ?? "", { resolve: options.resolve ?? resolveLink });
  if (decoded.kind === "pass") return { decision: "allow" };
  if (decoded.kind === "deny") return decoded.verdict;
  if (args.policy === undefined) return cannotJudge("the hook is wired without --policy");
  const policyFile = resolvePath(options.cwd, args.policy);
  const loaded = loadGuardPolicy(policyFile, PACKAGE_ROOT);
  if (loaded.policy === null) {
    const first = loaded.issues[0];
    return cannotJudge(
      `the policy at ${policyFile} did not load (${first?.rule ?? "no detail"}: ${first?.message ?? ""})`,
    );
  }
  const env = options.env ?? process.env;
  const context: GuardContext = { root: rootOf(args, env, decoded.cwd), cwd: decoded.cwd };
  const home = env.HOME;
  if (home !== undefined && isAbsolute(home)) context.home = home;
  return evaluate(loaded.policy, decoded.action, context);
}

/** `--root`, else the project directory Claude Code names for its hooks, else the call's own directory. */
function rootOf(args: HookArgs, env: NodeJS.ProcessEnv, cwd: string): string {
  if (args.root !== undefined && isAbsolute(args.root)) return args.root;
  const project = env.CLAUDE_PROJECT_DIR;
  return project !== undefined && isAbsolute(project) ? project : cwd;
}

/**
 * Where a path leads through symlinks on this filesystem: the real path of
 * the deepest part that exists, with the rest appended, so a new file under a
 * linked directory resolves too. Null when nothing is linked.
 */
export function resolveLink(absolute: string): string | null {
  let existing = absolute;
  let rest = "";
  for (;;) {
    try {
      const real = realpathSync(existing);
      const target = rest === "" ? real : join(real, rest);
      return target === absolute ? null : target;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return null;
      rest = rest === "" ? basename(existing) : join(basename(existing), rest);
      existing = parent;
    }
  }
}
