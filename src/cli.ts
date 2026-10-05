#!/usr/bin/env bun
/**
 * ak — validate, build and attach.
 *
 * Exit 0 when nothing failed, non-zero on any error. Every failure line names
 * the file and the rule that produced it.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

import { attach, formatAttachResult } from "./attach/index.ts";
import { scoreDelegationFiles } from "./delegation.ts";
import { runFirstmate } from "./firstmate/cli.ts";
import { readGuardStdin, runGuard } from "./guard/cli.ts";
import { main as runLifecycle } from "./lifecycle/gate.ts";
import { readHookStdin, runLearn } from "./learn/cli.ts";
import { runRunner } from "./runner/cli.ts";
import { loadCatalog } from "./catalog/load.ts";
import type { BuildOptions } from "./packaging/build.ts";
import { checkBundles, writeAdaptations, writeBundles } from "./packaging/build.ts";
import { describeInstall, loadInstallConfig } from "./packaging/install.ts";
import { checkTrackerBinding, findProjectRoot } from "./tracker/binding.ts";
import { ADAPTATIONS_FILE, checkAdaptationsSync } from "./validation/provenance.ts";
import type { CheckContext } from "./validation/context.ts";
import { runValidation } from "./validation/run.ts";
import { isSkillStyleIssue } from "./validation/skill-style.ts";
import {
  blockingSkips,
  error,
  formatIssue,
  hasErrors,
  skippedChecks,
  sortIssues,
  type Issue,
} from "./validation/types.ts";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliOptions {
  cwd: string;
  io: CliIo;
  /** A host hook's JSON payload, read from stdin by the entrypoint for `ak learn hook` and `ak guard hook`. */
  stdin?: string;
}

const USAGE = [
  "ak — the agent-kit contract tool",
  "",
  "  ak validate [--profile <id>] [--json]      check the tree against catalog.yaml",
  "  ak validate --skill-style                  print only the skill-authoring style warnings",
  "  ak build [--check] [--profile <id>|all]    emit dist/claude-code and dist/codex",
  "  ak attach <path-or-artifact> [--json]      select the packs an artifact activates",
  "  ak delegation <ticket> --project <path>   compute the evidenced delegation record",
  "  ak lifecycle open|record|check …           task-bound lifecycle gates for super-ship",
  "  ak firstmate <subcommand> …                bind agent-kit to a patched Firstmate home (optional)",
  "  ak tracker check [<project-dir>]           check a project folder's tracker binding and secret",
  "  ak doctor                                  inspect the installed hosts and current project",
  "  ak update                                  refresh installed ak plugins to the published version",
  "  ak learn <area> <verb> ...                 the opt-in learning runtime (`ak learn` for help)",
  "  ak guard hook <event> ...                  the opt-in guard runtime's host hook (`ak guard` for help)",
  "  ak runner serve|call ...                   runner service and charter-bound requests",
  "",
  "Exit 0 when nothing failed, non-zero on any error.",
];

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
  unknown: string[];
}

const VALUE_FLAGS = new Set(["profile", "host", "project"]);

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        unknown.push(token);
        continue;
      }
      if (inline === undefined) i += 1;
      flags.set(name, value);
      continue;
    }
    flags.set(name, inline ?? true);
  }
  return { command: positional[0], positional: positional.slice(1), flags, unknown };
}

function report(
  io: CliIo,
  issues: readonly Issue[],
  label: string,
  install?: string,
  whole: readonly Issue[] = issues,
): number {
  const sorted = sortIssues(issues);
  for (const issue of sorted) io.out(formatIssue(issue));
  // Counted from `whole`, like the skip clauses below: the summary line is the
  // receipt for the run and its exit code, not for the lines a filter printed.
  const counts = { error: 0, warning: 0, note: 0 };
  for (const issue of whole) counts[issue.severity] += 1;

  // Both skip terms are printed at zero like the other three, and that is the
  // point: "0 checks skipped" is the only thing that distinguishes a verified run
  // from one where the instrument was missing. Were the clause omitted when empty,
  // its absence would carry the claim, and a reader who does not know the
  // convention cannot tell a silent clause from a silent check.
  //
  // They are two clauses and not one because they mean opposite things about the
  // tree. A skipped check had nothing to judge; an unavailable one had its subject
  // sitting in front of it and no authority to judge it by, and only the second
  // fails the run. Collapsed into a single count, the summary said "1 check
  // skipped" for both and a reader gating on the exit code saw no difference.
  // Computed from `whole`, not `sorted`: a display filter (`--skill-style`)
  // narrows what gets printed above, but whether a check ran at all is a fact
  // about the whole run, not about which lines a reader asked to see. Deriving
  // these from the filtered set would let "0 checks skipped" stand in for a run
  // that really did skip one, which is the exact lie this pair of clauses exists
  // to rule out.
  const missed = skippedChecks(whole);
  const blocked = blockingSkips(whole);
  const clause = (n: number, word: string, names: string[]) =>
    `${n} check${n === 1 ? "" : "s"} ${word}${names.length === 0 ? "" : `: ${names.join(", ")}`}`;

  // Named on its own rather than folded into the warning count: skill-style
  // findings are `warning` or `note` severity depending on the check, so a
  // reader scanning only the warning count would undercount them. Printed at
  // zero for the same reason the skip clauses are (see below): its absence
  // would otherwise read as "not measured" rather than "measured, found none".
  const skillStyleCount = whole.filter(isSkillStyleIssue).length;
  // The install configuration rides on the summary line rather than a line of
  // its own, because the summary line is the receipt: it is what gets quoted,
  // and `research/probes/validate-figure.sh` takes the last line of output as
  // the figure. A skill's packaged mode now depends on `ak.install.yaml`, a file
  // no commit carries, so a figure that did not name the configuration it was
  // measured under could not be re-derived by anyone else (`AGENTS.md`,
  // "Receipts name their instrument"). Absent only where no catalog loaded and
  // nothing was measured under any configuration.
  const under = install === undefined ? "" : `; install: ${install}`;
  io.out(
    `${label}: ${counts.error} error${counts.error === 1 ? "" : "s"}, ${counts.warning} warning${counts.warning === 1 ? "" : "s"}, ${counts.note} note${counts.note === 1 ? "" : "s"}, ${skillStyleCount} skill-style warning${skillStyleCount === 1 ? "" : "s"}, ${clause(missed.length, "skipped", missed)}, ${clause(blocked.length, "unavailable", blocked)}${under}`,
  );
  return hasErrors(whole) || blocked.length > 0 ? 1 : 0;
}

function contextOf(cwd: string, io: CliIo): CheckContext | null {
  const { catalog, issues } = loadCatalog(cwd);
  if (catalog === null) {
    report(io, issues, "ak");
    return null;
  }
  return { root: cwd, catalog };
}

function buildOptions(parsed: Parsed): BuildOptions {
  const profile = parsed.flags.get("profile");
  return { profile: typeof profile === "string" ? profile : undefined };
}

function validate(parsed: Parsed, options: CliOptions): number {
  const result = runValidation(options.cwd, { build: buildOptions(parsed) });
  const install = result.catalog === null ? undefined : loadInstallConfig(options.cwd, result.catalog);
  // `--skill-style` narrows what is *printed* to the skill-authoring style
  // warnings alone; it never narrows what the exit code answers for. Those
  // warnings can never fail a run (src/validation/skill-style.ts), so an exit
  // code derived from the filtered set would always read 0 and would quietly
  // stop meaning "the tree is clean" the moment a real error sat outside it.
  const skillStyleOnly = parsed.flags.get("skill-style") === true;
  const shown = skillStyleOnly ? result.issues.filter(isSkillStyleIssue) : result.issues;
  if (parsed.flags.get("json") === true) {
    // `skipped` is beside `ok` and not only inside the issues, because `ok: true`
    // on a machine with no donor clones is the same value as `ok: true` on one
    // that verified every row. A consumer gating on `ok` alone cannot see that.
    // `unavailable` is separate again: those already fail `ok`, and a consumer
    // that wants to know *why* a clean-looking tree failed needs the term.
    options.io.out(
      JSON.stringify(
        {
          ok: result.ok,
          skipped: skippedChecks(result.issues),
          unavailable: blockingSkips(result.issues),
          install:
            install === undefined
              ? null
              : { file: install.file, attached: install.attached, backends: Object.fromEntries(install.backends) },
          issues: shown,
        },
        null,
        2,
      ),
    );
    return result.ok ? 0 : 1;
  }
  report(options.io, shown, "ak validate", install === undefined ? undefined : describeInstall(install), result.issues);
  return result.ok ? 0 : 1;
}

function build(parsed: Parsed, options: CliOptions): number {
  const ctx = contextOf(options.cwd, options.io);
  if (ctx === null) return 1;
  const opts = buildOptions(parsed);
  const install = describeInstall(loadInstallConfig(ctx.root, ctx.catalog));

  if (parsed.flags.get("check") === true) {
    return report(options.io, [...checkAdaptationsSync(ctx), ...checkBundles(ctx, opts)], "ak build --check", install);
  }

  // The merged provenance file is a source-tree artifact, not a bundle file:
  // NOTICE points a downstream consumer at it, so it is generated even when the
  // skills it will eventually record are not authored yet.
  const generated = writeAdaptations(ctx);
  if (generated.length > 0) {
    const code = report(options.io, generated, "ak build");
    options.io.err(`ak build: refusing to write ${ADAPTATIONS_FILE} from conflicting fragments`);
    return code === 0 ? 1 : code;
  }
  options.io.out(`ak build: wrote ${ADAPTATIONS_FILE}`);

  // A build that would ship a contract failure is not a build. Validate first,
  // write only when the tree is clean.
  const validation = runValidation(options.cwd, { build: opts });
  if (!validation.ok) {
    const code = report(options.io, validation.issues, "ak build", install);
    options.io.err("ak build: refusing to write dist/ while validation reports errors");
    return code === 0 ? 1 : code;
  }

  const built = writeBundles(ctx, opts);
  const code = report(options.io, built.issues, "ak build", install);
  if (code === 0) options.io.out(`ak build: wrote dist/ for profile ${built.profile}`);
  return code;
}

function attachCommand(parsed: Parsed, options: CliOptions): number {
  const subject = parsed.positional[0];
  if (subject === undefined) {
    options.io.err("ak attach: needs a path or artifact to attach packs to");
    for (const line of USAGE) options.io.err(line);
    return 2;
  }
  const ctx = contextOf(options.cwd, options.io);
  if (ctx === null) return 1;

  const result = attach(ctx, subject);
  if (parsed.flags.get("json") === true) {
    options.io.out(JSON.stringify(result, null, 2));
  } else {
    for (const line of formatAttachResult(result)) options.io.out(line);
  }
  return 0;
}

function delegationCommand(parsed: Parsed, options: CliOptions): number {
  const ticket = parsed.positional[0];
  const project = parsed.flags.get("project");
  if (ticket === undefined || parsed.positional.length !== 1 || project === undefined || project === true) {
    options.io.err("ak delegation: needs exactly one ticket path and --project <path>");
    for (const line of USAGE) options.io.err(line);
    return 2;
  }
  try {
    const record = scoreDelegationFiles(ticket, project, options.cwd);
    options.io.out(JSON.stringify(record, null, 2));
    return 0;
  } catch (cause) {
    options.io.err(`ak delegation: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}

/**
 * `ak tracker check`: a project folder's ak.tracker.yaml and the secret it names.
 *
 * The folder is the project's, not this tree, so the schema is read from this
 * package's own root (the directory above src/), never from the folder being
 * checked -- a folder cannot vouch for its own binding with a schema it ships.
 */
function trackerCommand(parsed: Parsed, options: CliOptions): number {
  if (parsed.positional[0] !== "check") {
    options.io.err("ak tracker: the only subcommand is check");
    for (const line of USAGE) options.io.err(line);
    return 2;
  }
  const dir = parsed.positional[1] ?? ".";
  const start = isAbsolute(dir) ? dir : join(options.cwd, dir);
  if (!existsSync(start) || !statSync(start).isDirectory()) {
    return report(
      options.io,
      [error("tracker.project-missing", dir, "Not a directory, so there is no project folder to check.")],
      "ak tracker check",
    );
  }
  // From a subdirectory, the binding that governs it is the nearest one above,
  // up to the repository's top level (findProjectRoot).
  return report(
    options.io,
    checkTrackerBinding(findProjectRoot(start), join(import.meta.dir, "..")),
    "ak tracker check",
  );
}

export function runCli(argv: readonly string[], options: CliOptions): number {
  if (argv[0] === "doctor" || argv[0] === "update") {
    const result = spawnSync(process.execPath, [join(import.meta.dir, "maintenance", "cli.ts"), ...argv], {
      cwd: options.cwd,
      encoding: "utf8",
      env: process.env,
    });
    if (result.stdout) for (const line of result.stdout.trimEnd().split("\n")) options.io.out(line);
    if (result.stderr) for (const line of result.stderr.trimEnd().split("\n")) options.io.err(line);
    return result.status ?? 1;
  }
  // Its own flags and its own parser: see src/firstmate/cli.ts.
  if (argv[0] === "lifecycle") return runLifecycle(argv.slice(1), options.io, options.cwd);
  if (argv[0] === "firstmate") return runFirstmate(argv.slice(1), options.io);
  // `ak learn` has its own argument grammar per area, so it is dispatched before
  // this file's parser sees flags it does not know.
  if (argv[0] === "learn") {
    return runLearn(argv.slice(1), { cwd: options.cwd, io: options.io, stdin: options.stdin });
  }
  if (argv[0] === "guard") {
    return runGuard(argv.slice(1), { cwd: options.cwd, io: options.io, stdin: options.stdin });
  }
  const parsed = parse(argv);
  for (const token of parsed.unknown) options.io.err(`ak: ${token} needs a value`);
  if (parsed.unknown.length > 0) return 2;

  switch (parsed.command) {
    case "validate":
      return validate(parsed, options);
    case "build":
      return build(parsed, options);
    case "attach":
      return attachCommand(parsed, options);
    case "delegation":
      return delegationCommand(parsed, options);
    case "tracker":
      return trackerCommand(parsed, options);
    case undefined:
      for (const line of USAGE) options.io.err(line);
      return 2;
    default:
      options.io.err(`ak: unknown command ${parsed.command}`);
      for (const line of USAGE) options.io.err(line);
      return 2;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };
  const code =
    argv[0] === "runner"
      ? await runRunner(argv.slice(1), io)
      : runCli(argv, { cwd: process.cwd(), io, stdin: readHookStdin(argv) ?? readGuardStdin(argv) });
  if (argv[0] !== "runner" || argv[1] !== "serve" || code !== 0) process.exit(code);
}
