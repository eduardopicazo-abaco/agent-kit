/**
 * Runtime configuration for `ak learn`, read from the environment once per run.
 *
 * No setting names a model. The judge is one configurable command, and which
 * model sits behind it is the runner's binding, not this package's (ruling
 * `learning-judge-is-runner-bound`).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface LearnConfig {
  /** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Ledgers live under `<configDir>/projects/`. */
  configDir: string;
  /** Runtime-wide state outside any project: the project registry and the tick log. */
  runtimeDir: string;
  /** The judge command as argv. The prompt goes to stdin; JSON comes back on stdout. */
  judgeCommand: string[];
  judgeTimeoutMs: number;
  /** claude-mem's SQLite database, opened read-only. */
  memDb: string;
  /** Review loop: events needed before a pattern is active, and before it is promoted. */
  activeAt: number;
  promoteAt: number;
  /** Memory loop. */
  idleS: number;
  reflectTokens: number;
  memoryTokens: number;
  nightlyHour: number;
  batch: number;
  /** Print decisions and prompts; write nothing. */
  dryRun: boolean;
}

/**
 * The default judge. `--settings` with every hook disabled keeps the judge's own
 * session out of observers such as claude-mem, and out of this runtime's hooks.
 * `--tools ""` leaves the judge no tools at all: its prompt carries text anyone
 * can write (review comments, observations), and a judge that can read files or
 * run commands turns that text into actions. The judgement needs only the prompt.
 * `--tools ""` covers only the built-in tools; `--strict-mcp-config` with no
 * `--mcp-config` keeps the user's and plugins' MCP servers out as well.
 * `--no-session-persistence` keeps each call from leaving a transcript in the
 * operator's project store.
 * `--bare` is deliberately absent: it also drops the login the call needs.
 */
export const DEFAULT_JUDGE = [
  "claude",
  "-p",
  "--tools",
  "",
  "--strict-mcp-config",
  "--settings",
  '{"disableAllHooks":true}',
  "--no-session-persistence",
  "--output-format",
  "json",
];

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Split a command string the way a shell would for the simple cases a judge
 * command needs: whitespace separation, single and double quotes, backslash
 * escapes outside single quotes. No expansion of any kind.
 */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) throw new Error(`unterminated ${quote} in command: ${text}`);
  if (started) out.push(current);
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LearnConfig {
  const configDir =
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() !== "" ? env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
  const memDir =
    env.CLAUDE_MEM_DATA_DIR && env.CLAUDE_MEM_DATA_DIR.trim() !== ""
      ? env.CLAUDE_MEM_DATA_DIR
      : join(homedir(), ".claude-mem");
  const judge =
    env.AK_LEARN_JUDGE && env.AK_LEARN_JUDGE.trim() !== "" ? splitCommand(env.AK_LEARN_JUDGE) : DEFAULT_JUDGE;
  return {
    configDir,
    runtimeDir: join(configDir, "agent-kit", "learn"),
    judgeCommand: judge,
    judgeTimeoutMs: int(env, "AK_LEARN_JUDGE_TIMEOUT_S", 300) * 1000,
    memDb:
      env.AK_LEARN_MEM_DB && env.AK_LEARN_MEM_DB.trim() !== "" ? env.AK_LEARN_MEM_DB : join(memDir, "claude-mem.db"),
    activeAt: int(env, "AK_LEARN_ACTIVE_AT", 2),
    promoteAt: int(env, "AK_LEARN_PROMOTE_AT", 3),
    idleS: int(env, "AK_LEARN_IDLE_S", 300),
    reflectTokens: int(env, "AK_LEARN_REFLECT_TOKENS", 25_000),
    memoryTokens: int(env, "AK_LEARN_MEMORY_TOKENS", 2_500),
    nightlyHour: int(env, "AK_LEARN_NIGHTLY_HOUR", 2),
    batch: int(env, "AK_LEARN_BATCH", 24),
    dryRun: env.AK_LEARN_DRY_RUN === "1",
  };
}
