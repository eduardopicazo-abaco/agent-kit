/**
 * The Claude Code decoder and encoder around the guard evaluator
 * (docs/decisions/0009-constitution-support.md, Decision 2).
 *
 * The decoder turns the PreToolUse payload Claude Code writes to a command
 * hook's stdin into one normalized GuardAction and the call's working
 * directory. It parses once and keeps child-guard.sh's discipline: a payload
 * that is not a JSON object, has no `tool_name`, or names a tool it judges
 * with an input it cannot read is denied as `guard.unjudgeable`. The payload
 * shape is the one claude 2.1.288 sends: the session fields, `cwd`,
 * `hook_event_name`, `tool_name`, `tool_input` and `tool_use_id`, plus
 * `agent_id` and `agent_type` inside a subagent, which are judged the same.
 *
 * The judged tools are the ones whose effect on a file the payload names:
 * Bash, the file tools and Grep. Any other tool (web, agents, MCP tools,
 * planning) passes unjudged, so a file an MCP tool writes is a gap of this
 * decoder. PowerShell text is denied as unjudgeable: the evaluator lexes
 * POSIX shell only.
 *
 * The evaluator does not resolve symlinks (schemas/guard-policy.schema.json),
 * so for a file tool the decoder adds the path a link leads to, through the
 * `resolve` it is handed: the hook passes one that reads the filesystem, and a
 * replay passes the links its fixture declares. A link a shell command writes
 * through is not resolved; creating a link inside a protected path is a write
 * to it and is judged as one.
 *
 * The encoder emits a deny as `hookSpecificOutput.permissionDecision: "deny"`
 * with the reason, on stdout, exit 0, and an allow as silence, exit 0
 * (research/host-facts/2026-10-03/claude-code-1-hook-failures.md). It never
 * relies on exit 2, and never emits `allow`, which would skip the permission
 * prompt the user's own rules ask for. A guard that times out, crashes or is
 * missing lets the call through on this host; that is the host's behavior,
 * not the guard's, and it is why the guard is feedback and never the boundary.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import type { GuardAction } from "../action.ts";
import { shellAction } from "../action.ts";
import { UNJUDGEABLE, type GuardVerdict } from "../evaluate.ts";

/** A payload the evaluator should judge, a call the guard does not judge, or a deny the decoder settles itself. */
export type ClaudeCodeDecoded =
  | { kind: "judge"; tool: string; action: GuardAction; cwd: string; sessionId: string | null }
  | { kind: "pass"; tool: string }
  | { kind: "deny"; verdict: GuardVerdict & { decision: "deny" } };

/** What a command hook hands back to Claude Code. */
export interface HookResponse {
  stdout: string;
  exit: 0;
}

/** The real path an absolute path leads to through symlinks, or null when it is the same or cannot be told. */
export type LinkResolver = (absolute: string) => string | null;

export interface DecodeOptions {
  resolve?: LinkResolver;
}

export const CLAUDE_CODE_EVENT = "PreToolUse";

/** The fields of the payload every call carries that the decoder reads; the rest is the host's. */
interface Envelope {
  tool_name: string;
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_input?: object;
}

type Mapped = { kind: "action"; action: GuardAction } | { kind: "pass" } | { kind: "bad"; why: string };

const ajv = new Ajv2020({ strict: false });

const envelope = ajv.compile<Envelope>({
  type: "object",
  required: ["tool_name"],
  properties: {
    tool_name: { type: "string", minLength: 1 },
    hook_event_name: { type: "string" },
    cwd: { type: "string" },
    session_id: { type: "string" },
    tool_input: { type: "object" },
  },
});

/** A tool_input whose `field` is a non-empty string, required or not. */
function stringField<T>(field: string, required: boolean): ValidateFunction<T> {
  return ajv.compile<T>({
    type: "object",
    required: required ? [field] : [],
    properties: { [field]: { type: "string", minLength: 1 } },
  });
}

const commandInput = stringField<{ command: string }>("command", true);
const fileInput = stringField<{ file_path: string }>("file_path", true);
const notebookInput = stringField<{ notebook_path: string }>("notebook_path", true);
const grepInput = stringField<{ path?: string }>("path", false);

/** Tools that write the one file their `file_path` names. */
const FILE_WRITERS = new Set(["Write", "Edit", "MultiEdit"]);

function unjudgeable(why: string): ClaudeCodeDecoded {
  return {
    kind: "deny",
    verdict: { decision: "deny", rule: UNJUDGEABLE, reason: `The guard cannot judge this call: ${why}.` },
  };
}

function firstError(validate: ValidateFunction): string {
  const first = validate.errors?.[0];
  return first === undefined ? "it is invalid" : `${first.instancePath || "(root)"} ${first.message ?? "is invalid"}`;
}

/** Decode one PreToolUse payload, exactly as read from stdin. */
export function decodeClaudeCode(stdin: string, options: DecodeOptions = {}): ClaudeCodeDecoded {
  let value: unknown;
  try {
    value = JSON.parse(stdin);
  } catch {
    return unjudgeable("the hook input is not JSON");
  }
  if (!envelope(value)) return unjudgeable(`the hook input is not a tool call payload (${firstError(envelope)})`);
  const tool = value.tool_name;
  const event = value.hook_event_name;
  if (event !== undefined && event !== CLAUDE_CODE_EVENT) {
    return unjudgeable(`the hook input is a ${event} event, not ${CLAUDE_CODE_EVENT}`);
  }
  const mapped = actionOf(value);
  if (mapped.kind === "pass") return { kind: "pass", tool };
  if (mapped.kind === "bad") return unjudgeable(`the ${tool} call ${mapped.why}`);
  const cwd = value.cwd;
  if (cwd === undefined || !cwd.startsWith("/")) return unjudgeable(`the ${tool} call carries no absolute cwd`);
  const action = options.resolve === undefined ? mapped.action : withLinkTargets(mapped.action, cwd, options.resolve);
  const sessionId = value.session_id === undefined || value.session_id === "" ? null : value.session_id;
  return { kind: "judge", tool, action, cwd, sessionId };
}

/** The action a tool call amounts to, a pass for a tool the guard does not judge, or why its input cannot be read. */
function actionOf(call: Envelope): Mapped {
  const { tool_name: tool, tool_input: input } = call;
  const judged =
    tool === "Bash" ||
    tool === "PowerShell" ||
    tool === "Read" ||
    tool === "Grep" ||
    tool === "NotebookEdit" ||
    FILE_WRITERS.has(tool);
  if (!judged) return { kind: "pass" };
  if (input === undefined) return { kind: "bad", why: "has no tool_input object" };
  if (tool === "PowerShell") return { kind: "bad", why: "is PowerShell, which the guard does not parse" };
  if (tool === "Bash") {
    if (!commandInput(input)) return { kind: "bad", why: "has no command string" };
    return { kind: "action", action: shellAction(input.command) };
  }
  if (tool === "Grep") {
    if (!grepInput(input)) return { kind: "bad", why: "has a path that is not a non-empty string" };
    // With no path Grep searches the working tree, as `grep -r needle .` does, which the shell rules allow.
    if (input.path === undefined) return { kind: "pass" };
    return { kind: "action", action: { kind: "read", paths: [input.path] } };
  }
  if (tool === "NotebookEdit") {
    if (!notebookInput(input)) return { kind: "bad", why: "has no notebook_path string" };
    return { kind: "action", action: { kind: "write", paths: [input.notebook_path] } };
  }
  if (!fileInput(input)) return { kind: "bad", why: "has no file_path string" };
  const paths = [input.file_path];
  return { kind: "action", action: tool === "Read" ? { kind: "read", paths } : { kind: "write", paths } };
}

/** A file action with each path's link target added after it; a shell action is returned as it is. */
function withLinkTargets(action: GuardAction, cwd: string, resolve: LinkResolver): GuardAction {
  if (action.kind === "shell") return action;
  const paths: string[] = [];
  for (const path of action.paths) {
    paths.push(path);
    const target = resolve(path.startsWith("/") ? path : `${cwd}/${path}`);
    if (target !== null && !paths.includes(target)) paths.push(target);
  }
  return { ...action, paths };
}

/** The hook's stdout and exit code for a verdict: a JSON deny, or silence. Exit 0 either way. */
export function encodeClaudeCode(verdict: GuardVerdict): HookResponse {
  if (verdict.decision === "allow") return { stdout: "", exit: 0 };
  const output = {
    hookSpecificOutput: {
      hookEventName: CLAUDE_CODE_EVENT,
      permissionDecision: "deny",
      permissionDecisionReason: `agent-kit guard [${verdict.rule}]: ${verdict.reason}`,
    },
  };
  return { stdout: `${JSON.stringify(output)}\n`, exit: 0 };
}
