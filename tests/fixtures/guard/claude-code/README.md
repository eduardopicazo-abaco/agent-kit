# Claude Code replay fixtures for the guard

Each case is two files. `<case>.stdin` holds the exact bytes a PreToolUse command hook reads on
stdin from claude 2.1.288: one JSON object with no trailing newline, carrying `session_id`,
`transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`, `tool_name`,
`tool_input` and `tool_use_id`, plus `agent_id` and `agent_type` inside a subagent. The
`unjudgeable-*` cases break that shape on purpose. `<case>.expected.json` holds the decision.

The payloads are invented in that version's shape. Their field order and tool input fields were
read from the installed 2.1.288 binary, and no session's values were copied. They name a workspace
at `/work/repo` that no test creates, and are judged against `tests/fixtures/guard/policy.yaml`.

`tests/guard/claude-code.test.ts` runs every case through `ak guard hook pre-tool-use`, which
decodes, evaluates and encodes it, and reads the answer the way Claude Code does. A deny is
`hookSpecificOutput.permissionDecision: "deny"` on stdout with exit 0, and an allow is silence.

An expected file has these fields:

| Field | Meaning |
|---|---|
| `why` | One line on what the case shows |
| `decision` | `allow`, `deny`, or `fail-open` for a case the host lets through whatever the guard would say |
| `rule` | The rule id a deny names |
| `links` | Symlinks the case assumes, from an absolute path to where it leads. They stand in for the filesystem |
| `when_answered` | For `fail-open`: the guard's answer when it does answer in time |
| `receipt` | The host-fact receipt under `research/host-facts/2026-10-03/` that the case rests on |

`timeout-fail-open` records the gap that `claude-code-1` describes. A command hook that does not
answer before its timeout does not block the call, so a call the guard would deny runs anyway.

When the decoder is moved to a new Claude Code version, compare that version's payload against these
cases and change the version named here in the same commit. A payload change that the decoder does
not handle should fail a case. It should never leave the guard silent.
