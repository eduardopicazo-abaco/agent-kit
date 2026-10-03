/**
 * The one judgement call the learning runtime makes: a prompt in, a JSON object out.
 *
 * The command is configuration (`AK_LEARN_JUDGE`), so which model answers is
 * the runner's binding and never this package's (ruling
 * `learning-judge-is-runner-bound`). Whatever comes back is checked by
 * deterministic gates before it touches a ledger; the judge never sets counts,
 * status, ids or rates.
 */
import { mkdirSync } from "node:fs";
import type { LearnConfig } from "./config.ts";
import { run } from "./proc.ts";

/** Variables that make a nested CLI believe it is running inside the parent session. */
const NESTED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

export type JudgeFn = (prompt: string) => Record<string, unknown> | null;

/**
 * Pull the first JSON object out of a judge reply. Accepts the host's JSON
 * envelope (`{"result": "..."}`), a bare object, a fenced block or an object
 * embedded in prose.
 */
export function extractJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  let content: unknown;
  try {
    const wrapper = JSON.parse(trimmed) as unknown;
    content =
      wrapper !== null && typeof wrapper === "object" && !Array.isArray(wrapper) && "result" in wrapper
        ? wrapper.result
        : wrapper;
  } catch {
    content = trimmed;
  }
  if (content !== null && typeof content === "object" && !Array.isArray(content))
    return content as Record<string, unknown>;
  if (typeof content !== "string") return null;
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(content);
  const bare = fenced ?? /(\{[\s\S]*\})/.exec(content);
  if (bare === null) return null;
  try {
    const parsed = JSON.parse(bare[1]!) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A role's declared `unavailable` (`{"unavailable": "<why>"}`). It is a result, not a
 * malformed reply: callers treat it as a failed run that writes nothing, and it is
 * never retried (ruling `required-lane-failure-is-unavailable`).
 */
export function declaredUnavailable(reply: Record<string, unknown> | null): string | null {
  if (reply === null) return null;
  const why = reply.unavailable;
  return typeof why === "string" && Object.keys(reply).length === 1 ? why : null;
}

/** A judge bound to the configured command. One retry on an empty, failed or unparseable reply. */
export function commandJudge(config: LearnConfig): JudgeFn {
  return (prompt: string) => {
    mkdirSync(config.runtimeDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!NESTED_SESSION_VARS.includes(key)) env[key] = value;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run(config.judgeCommand, {
        cwd: config.runtimeDir,
        input: prompt,
        env,
        timeoutMs: config.judgeTimeoutMs,
      });
      if (result.timedOut) return null;
      if (result.code !== 0) continue;
      const parsed = extractJson(result.stdout);
      if (parsed !== null) return declaredUnavailable(parsed) === null ? parsed : null;
    }
    return null;
  };
}
