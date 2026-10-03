# adapters/claude-code — host contract

Contract only. No implementation lives here; the packager that emits this bundle is `src/packaging/`.

This file states what the Claude Code host provides, what the package requires of it, which
`schemas/common.schema.json#/$defs/capability` values it can actually satisfy, how the contract
degrades where it cannot, and how the result is tested.

Observations below marked **verified** were taken against `claude` 2.1.278 on this machine
(`claude plugin validate --strict`, `claude plugin eval`). Everything else is stated as a
requirement on the packager, not as a claim about host behavior.

---

## 1. Bundle shape

`ak build` emits:

```text
dist/claude-code/
├── .claude-plugin/
│   ├── plugin.json            # enumerates skills[] explicitly
│   └── marketplace.json       # one entry, source "./"
├── skills/<id>/SKILL.md       # host frontmatter keys generated; body unchanged
├── skills/<id>/references/    # transitive dependencies resolved into the bundle
├── evals/<id>/<case>/case.yaml
└── NOTICE, LICENSE
```

`plugin.json` enumerates every skill path **explicitly** rather than relying on directory
discovery:

```json
{
  "name": "ak",
  "version": "0.1.0",
  "description": "One engineering lifecycle, amalgamated from nine donors: eight MIT, one Apache-2.0.",
  "author": { "name": "agent-kit maintainers" },
  "license": "MIT",
  "skills": ["./skills/super-align", "./skills/super-bound"],
  "experimental": { "evals": "evals" }
}
```

Explicit enumeration is a package decision, not a donor practice — the donor at
`compound-engineering@05c42da:.claude-plugin/plugin.json` declares no `skills` key at all and lets
the host discover `skills/`. The package enumerates because the install set is profile-dependent
(`profiles/core.yaml` is not the whole catalog), so the manifest is the one place where "what this
bundle actually contains" is stated and testable. An enumerated path that does not exist, or a skill
directory that no entry names, is an `ak build` failure.

**Verified:** an explicit `skills` array of relative directory paths and an `experimental.evals`
string both pass `claude plugin validate --strict`.

---

## 2. Generated frontmatter keys

The canonical `SKILL.md` carries spec keys only (`AUTHORING.md` §4). This adapter adds:

| Generated key | Source in `skill.yaml` | Rule |
|---|---|---|
| `argument-hint` | `packaging.generated_frontmatter.argument-hint` | Copied verbatim when present; omitted otherwise |
| `allowed-tools` | `packaging.generated_frontmatter.allowed-tools`, cross-checked against `requires[]` through §3 | Pre-approval only — see §4 |

No skill receives `disable-model-invocation`, U or M (`docs/decisions/0003-model-invocation.md`). Every skill is loadable by
the model, so each U skill's `packaging.hosts[]` entry for this host is `mode: manual` and names the
unrequested suppression in `unsupported`, as `adapters/codex/CONTRACT.md` §3.1 requires of a host
that does not suppress model invocation.

Each skill's `packaging.hosts[]` entry for `adapter: claude-code` carries the `mode` it runs in here
(`autonomous` / `guided` / `manual`) and the `unsupported` semantics this host cannot enforce. §4 is
what those entries must be consistent with. The packager (`ak build`) caps a skill's mode at what
its `requires[]` needs and this install supplies: a capability §3 marks `not-provided` counts as
supplied only when an attached adapter's contract states it supplies that capability and fails
closed without configuration. A skill capped only because such an adapter is not attached is
packaged at the capped mode with a note; one requiring a capability no adapter supplies, or one §3
does not list, fails the build (ruling `fail-closed-adapter-lifts-ceiling`).

**Verified:** `disable-model-invocation`, `argument-hint`, `allowed-tools`, `license` and `metadata`
all pass `claude plugin validate --strict` in a skill's frontmatter. That acceptance is exactly why
hand-writing them into the canonical tree cannot be caught downstream, and why `ak validate` rejects
them at the source (`AUTHORING.md` §4).

---

## 3. Capability support

`common#/$defs/capability` values, and what this host does with each.

The **Status** column is a controlled vocabulary — `satisfied`, `partial`, `convention-only`,
`not-provided` — and this table is the only place each value is stated. `ak validate` parses it
out of this file rather than reading a generated copy: a second artifact carrying these
classifications would be a second thing to keep in step, and the one that decides would be
whichever the code happened to read. Nuance belongs in **Detail**, never in Status, because a
compound status is a value no consumer can act on.

| Capability | Status | Detail |
|---|---|---|
| `repository-read` | `satisfied` | Read, Glob, Grep over the session's working directory |
| `repository-write` | `satisfied` | Write, Edit |
| `process-exec` | `satisfied` | Bash, subject to the operator's permission settings |
| `network-fetch` | `satisfied` | WebFetch, WebSearch, subject to the same settings |
| `vcs-local` | `satisfied` | Through `process-exec` (`git`) |
| `vcs-remote` | `satisfied` | Through `process-exec` (`git`, `gh`); credentials are the operator's, never the package's |
| `human-channel` | `satisfied` | The interactive session is the channel |
| `artifact-write` | `partial` | Satisfied for storage, **not** for binding. The host writes the file; it does not compute or check the artifact hash. Hash binding is the package's own responsibility (`schemas/common.schema.json#/$defs/envelope`). Every skill that emits a run artifact requires this capability (`capability.artifact-write-missing`), and that is most of the catalog, so reading its status as `satisfied` would silently certify hash binding for every run artifact the package writes |
| `isolated-worktree` | `convention-only` | `git worktree` is reachable through `process-exec`, but the host does not confine the session to the worktree it created. Ownership is enforced by `protocols/worktree-ownership`, not by the host |
| `isolated-review-context` | `partial` | The host provides fresh-context subagents. It provides no attestation that a reviewer context never saw the author's narrative, so the package cannot verify the property it depends on |
| `independent-context` | `partial` | Same limitation. Independence here is a convention of how the session is driven, not a host guarantee |
| `kb-read` | `not-provided` | The host supplies transport only. See `adapters/knowledgebase/CONTRACT.md` |
| `kb-write` | `not-provided` | The host supplies transport only. See `adapters/knowledgebase/CONTRACT.md` |
| `tracker-access` | `not-provided` | See `adapters/tracker/CONTRACT.md` |
| `event-delivery` | `not-provided` | The host is session-scoped. Hooks fire inside a live session; there is no durable inbound event queue that survives the session, so no event can be delivered to a run that is not currently open |
| `runner-grants` | `not-provided` | The host has no grant validator. Nothing in it can decide that a charter authorizes a checkpoint |
| `trusted-evidence` | `not-provided` | The worker and the evidence store share one OS authority, so the host cannot attest evidence the worker can edit |
| `firstmate-supervision` | `not-provided` | The host is the worker's harness, not a supervisor over it. See `adapters/firstmate/CONTRACT.md` |

**"See `adapters/<x>/CONTRACT.md`" names where a capability can come from with that adapter
attached. It is not a claim that this host supplies it, and it is not what decides attachment.**
`tracker-access` is the proof: it carries a pointer, yet whether the tracker adapter lifts it
depends on more than attaching it. With no backend configured, that adapter falls back on the
knowledgebase and borrows its refusal, so it lifts `tracker-access` only where `kb-write` is
available too (`adapters/tracker/CONTRACT.md` §1; ruling `tracker-of-record-falls-back-to-kb`). This
table states what **the host alone** guarantees. What an install adds on top is read from the
supply table in §1 of each attached adapter's contract, and which adapters are attached is the
install's decision, stated in `ak.install.yaml` at the tree root; with no such file, every adapter
whose contract supplies a capability and fails closed on it is attached (ruling
`fail-closed-adapter-lifts-ceiling`).

---

## 4. Host-capability honesty

This is the part of the contract that must not be softened.

**`allowed-tools` is a pre-approval mechanism, not a sandbox.** The Agent Skills specification marks
it experimental, and Claude Code documents it as pre-approval: listing tools removes permission
prompts for them. It does **not** deny the tools that are absent from the list. A skill that declares
`allowed-tools: Read, Glob, Grep` can still call Bash if the session's permission settings allow
Bash. Plan §1.3 states this directly: "Do not assume that a host's manual-invocation flag is
portable, or that an allowed-tools declaration denies every other tool."

Consequences the package accepts:

- A skill's `## Side effects` section is a **declaration** that `ak validate` checks against
  `skill.yaml` and that the eval suite probes. It is not a confinement the host enforces.
- "Reviewers cannot edit" (`super-review`) is enforced by the review protocol and observed by an
  eval case, not by `allowed-tools`.
- Nothing in this catalog may cite `allowed-tools` as the reason a destructive action cannot happen.

**What this host does enforce**, and the package relies on:

| Restriction | Enforced? | How the package treats it |
|---|---|---|
| `disable-model-invocation: true` blocks model-initiated invocation | Yes, as documented host behavior | **Not used.** The packager does not emit it (`docs/decisions/0003-model-invocation.md`), so `no-model-invocation` is not claimed. A U skill's description clause and stop-first workflow step hold the law — `ak validate`'s `human-start` check fails a U skill missing either — and its non-trigger eval case is what observes them in a session |
| Permission prompts / permission modes | Yes, operator-configured | Outside the package's control and outside its guarantees. A skill never assumes a given mode |
| `allowed-tools` denies unlisted tools | **No** | Never relied on. Declarative only |
| Grant validation for delegated phase operations | **No** | See below |
| Durable event delivery | **No** | See below |
| Attested context isolation between seats | **No** | See below |

**The degradation rule.** A host that cannot enforce a restriction an autonomous run requires
**exposes the affected skill in guided/manual mode and rejects autonomous mode.** It never runs the
skill with the restriction silently absent. Plan §1.2: "A host lacking those restrictions must expose
the skill in guided/manual mode rather than silently weakening the contract."

A capability this host does not provide, but that an **attached** adapter supplies and fails closed
on, is not silently absent: when it is unconfigured, an operation needing it refuses instead of
proceeding without it. Such a capability does not cap the mode. Attachment is decided by
the install configuration (`ak.install.yaml`, `schemas/install.schema.json`), and the default, when
that file is absent, is every fail-closed adapter attached. `attached: []` is this host alone, and
the list below is what it degrades to (ruling `fail-closed-adapter-lifts-ceiling`). The rule reaches
capabilities only; it grants no authority, so everything below about `delegated-grant` and
`explicit-or-delegated` entrypoints holds whatever is attached, and a grant is still validated by the
runner or not at all.

Concretely, on this host alone, with no runner attached:

- Entrypoints whose authority is `delegated-grant` are **unavailable**. They do not fall back to
  `explicit`; a delegated-only operation with no grant validator has no legitimate starter.
- Entrypoints whose authority is `explicit-or-delegated` install and run in their **explicit** form
  only. The delegated form is unavailable.
- `profiles/autonomy` — `autopilot` and the operational loops — **does not install** against this
  host on its own. Its `requires` include `runner-grants` and `event-delivery`, neither of which
  this host provides. `ak build` refuses the combination rather than emitting a bundle whose skills
  describe checkpoints nobody can validate.
- A checkpoint that would need two independent supervisor seats stops for explicit human decision,
  because this host cannot attest that two seats were independent.

---

## 5. Install, validate, test

```bash
# Install
claude plugin marketplace add Pibomeister/agent-kit
claude plugin install ak@agent-kit --scope project # restart required; skills appear under /ak:

# Validate the built bundle — CI gate
claude plugin validate dist/claude-code --strict

# Behavioral suite against the built bundle
claude plugin eval dist/claude-code --threshold 1.0 --no-publish
```

`--strict` treats warnings as errors and is the form CI runs; it fails on unrecognized fields and
missing metadata that the runtime would otherwise tolerate.

Tests this adapter owns, in `tests/adapters/`:

1. **Manifest completeness** — every profile-selected skill appears in `skills[]`, every entry
   resolves to a directory containing a `SKILL.md`, and no directory is unnamed.
2. **Key generation** — no emitted frontmatter contains `disable-model-invocation`, for a U skill
   or an M skill (`docs/decisions/0003-model-invocation.md`).
3. **Canonical purity** — an invalid-case fixture in which a canonical `SKILL.md` hand-writes
   `allowed-tools` must fail `ak validate`.
4. **Link closure in the bundle** — a skill referencing a `references/` file that the selected
   profile excludes fails the build.
5. **Autonomy refusal** — building `profiles/autonomy` against this host without a runner adapter
   fails with the missing capabilities named.
6. **Host conformance** — `claude plugin validate dist/claude-code --strict` exits zero.
7. **Non-trigger behavior** — each U skill's non-trigger eval case does not carry out the skill's
   workflow: its decisive `llm` grader and the no-side-effect graders beside it (AUTHORING.md §9)
   hold, whether or not the skill loaded.

---

## 6. What this adapter does not own

Load order beyond the manifest's enumeration, the operator's permission settings, credential
handling, MCP server configuration, and anything that would require the package to inspect the user's
session. A behavior that cannot be produced from this bundle's own files belongs to the runner
contract, not here.

---

## 7. The learning runtime's hooks

Under the opt-in `learning` profile, `ak learn setup wire` registers two hooks in the operator's
host settings: `ak learn hook session-start` on `SessionStart` and `ak learn hook stop` on `Stop`.
They inject the working memory and active guardrails at session start and queue ingestion when a
session ends. User corrections reach the runtime on this host from claude-reflect's per-project
queue, read-only, where that plugin is installed, rather than from a prompt hook. This bundle ships none of them: no skill in it requires
a hook, every skill behaves the same with them absent, and `ak learn setup uninstall` removes what
`wire` added. The runtime is a host adapter, not a phase, and its ledgers live under the host's
configuration directory, never inside a project repository (ruling
`learning-runtime-is-host-adapter`).

The default judge model follows the operator's current host selection. An operator who needs a fixed
judge model pins the complete command through `AK_LEARN_JUDGE` in their own environment; scheduler
setup carries that setting into the unit. The default command disables session persistence and runs
from the learning runtime directory so it neither leaves project transcripts nor discovers project
instructions from its working directory. `ak learn setup doctor` checks scheduled auth without a
judge call; only its explicit `--live-judge` flag sends a no-op prompt. The host CLI documents
`--disable-slash-commands` as disabling skills and `--setting-sources` as selecting settings inputs,
but documents no login guarantee for either. The runtime therefore adopts neither: login
preservation is required before a context-reduction flag can enter the scheduled path.
