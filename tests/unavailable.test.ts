/**
 * The second kind of skip: a check whose *authority* is absent, not its subject.
 *
 * `skipped()` exists because severity cannot say "did not look". This file exists
 * because "did not look" turned out to have two kinds, and severity cannot say
 * which of those either.
 *
 * `.donors/` absent is a check with nothing to judge: the subject is gone, empty
 * is the correct answer, and blocking on it would be wrong -- `validate-figure.sh`
 * depends on that. §12.2's anchors reworded is the opposite: the subject, 29 role
 * bodies, is entirely present, and what went missing is the contract the check
 * measures them against. That is `required-lane-failure-is-unavailable` in terms
 * -- a required lane that could not be given its context returns `unavailable`,
 * and an `unavailable` required lane blocks approval.
 *
 * Found by `sweep-reviewer` against `817b583`: rewording an anchor, leaving the
 * row text untouched, took `ak validate` from exit 1 to exit 0 with a gutted row
 * still in the tree. The gate enforcing that row was the one row it did not
 * apply to itself.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "../src/cli.ts";
import { runValidation } from "../src/validation/run.ts";
import {
  blockingSkips,
  hasBlockingSkips,
  skipped,
  skippedChecks,
  unavailable,
  type Issue,
} from "../src/validation/types.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
`;

function capture() {
  const out: string[] = [];
  return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) }, text: () => out.join("\n") };
}

describe("the two kinds of skip are distinguishable, because only one of them blocks", () => {
  test("a subject-absent skip names its check and does not block", () => {
    const issue = skipped("x.subject-gone", "catalog.yaml", "donor paths at pin", "nothing to judge");
    expect(issue.skipped).toBe("donor paths at pin");
    expect(issue.blocking).toBeUndefined();
    expect(hasBlockingSkips([issue])).toBe(false);
  });

  test("an authority-absent skip names the same check and does block", () => {
    const issue = unavailable(
      "x.authority-gone",
      "AUTHORING.md",
      "mandated role rows",
      "subject present, contract not",
    );
    expect(issue.skipped).toBe("mandated role rows");
    expect(issue.blocking).toBe(true);
    expect(hasBlockingSkips([issue])).toBe(true);
  });

  test("severity does not carry the difference, which is why the axis exists", () => {
    // Both are notes. Were `unavailable` an error, the argument in `skipped`'s
    // own docstring would apply to it: an error grades a finding, and a check
    // that did not run has no finding to grade.
    expect(skipped("a", "f", "c", "m").severity).toBe("note");
    expect(unavailable("a", "f", "c", "m").severity).toBe("note");
  });

  test("the two lists are disjoint, so a reader is never told the same term twice", () => {
    const issues: Issue[] = [
      skipped("a.one", "f", "donor paths at pin", "m"),
      unavailable("b.two", "g", "mandated role rows", "m"),
    ];
    expect(skippedChecks(issues)).toEqual(["donor paths at pin"]);
    expect(blockingSkips(issues)).toEqual(["mandated role rows"]);
  });
});

describe("a blocking skip reaches the exit code, which is the whole point", () => {
  /** A tree whose only issue is the skip under test. */
  function runWith(issue: Issue) {
    const root = makeTree({ "catalog.yaml": CATALOG });
    return runValidation(root, {
      only: ["injected"],
      extraChecks: [{ name: "injected", run: () => [issue] }],
    });
  }

  test("a run with no errors and a non-blocking skip is ok", () => {
    const result = runWith(skipped("x.subject", "catalog.yaml", "donor paths at pin", "m"));
    expect(result.issues.some((i) => i.severity === "error")).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("a run with no errors and a blocking skip is not ok", () => {
    // The assertion the old exit code could not make. `hasErrors` is false in
    // both runs above and below; only this axis separates them.
    const result = runWith(unavailable("x.authority", "AUTHORING.md", "mandated role rows", "m"));
    expect(result.issues.some((i) => i.severity === "error")).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("the summary line says which kind, at zero as well as above it", () => {
  function validateWith(files: Record<string, string>) {
    const root = makeTree({ "catalog.yaml": CATALOG, ...files });
    const io = capture();
    const code = runCli(["validate"], { cwd: root, io: io.io });
    return { code, text: io.text() };
  }

  test("the unavailable clause is printed at zero, not omitted when empty", () => {
    // Same argument as the existing "0 checks skipped": a clause that vanishes
    // when empty puts the claim in its own absence, and a reader who does not
    // know the convention cannot tell a silent clause from a silent check. This
    // tree has no unavailable check, so the literal below is the zero case.
    const { text, code } = validateWith({});
    expect(text).toContain("0 checks unavailable");
    // And a run whose only skips are non-blocking still passes.
    expect(code).toBe(0);
  });

  test("a tree whose contract cannot be read for entries that exist fails the run", () => {
    // The end-to-end shape of the bug: subject present, authority absent. An
    // open entry is in the tree and there is no AUTHORING.md to resolve it
    // against, so the check cannot run and the run does not pass.
    const open = ["# Contract defects", "", "## Open", "", "### one", "", "§5 requires:", "", "> something", ""].join(
      "\n",
    );
    const { text, code } = validateWith({ "CONTRACT-DEFECTS.md": open });
    expect(text).toContain("1 check unavailable: defect entry quotations");
    expect(code).toBe(1);
  });

  test("the same tree with no open entry is a skip and still passes", () => {
    // The paired control. Identical missing authority; the only difference is
    // whether anything in the tree went unexamined, which is the distinction.
    const { text, code } = validateWith({ "CONTRACT-DEFECTS.md": "# Contract defects\n\n## Open\n" });
    expect(text).toContain("0 checks unavailable");
    expect(code).toBe(0);
  });

  // The only test in the suite that validates the whole repository rather than a
  // synthetic tree, so it is the only one whose cost grows with the repository.
  // It was written under bun's default 5s per-test budget, which nobody chose
  // and which the tree silently outgrew: measured on a clean HEAD extract it
  // takes 12.2s, and `bun run src/cli.ts validate` on the same extract takes
  // 13.4s -- the test is the validator, not overhead around it. The dominant
  // term is `rulings.uncited-restatement`, which scores every window in the tree
  // against every ruling, so this number rises with any file added anywhere and
  // is nothing to do with what this test asserts.
  //
  // The budget is stated rather than left to the default because an implicit one
  // turns a passing test red on a commit that did not touch it, which is what
  // happened here: HEAD fails this test on its own. Raising it does not weaken
  // the assertion -- the assertion is about two clauses in the summary line, and
  // no timing claim was ever intended. If this starts timing out again, the
  // finding is the validator's runtime and belongs in a profile, not in a larger
  // number here.
  const WHOLE_REPO_VALIDATE_MS = 60_000;

  test(
    "the repository's own run names its unavailable checks separately from its skipped ones",
    () => {
      const repo = join(import.meta.dir, "..");
      const io = capture();
      runCli(["validate"], { cwd: repo, io: io.io });
      const summary =
        io
          .text()
          .split("\n")
          .filter((l) => l.startsWith("ak validate:"))
          .at(-1) ?? "";
      expect(summary).toMatch(/\d+ checks? skipped/);
      expect(summary).toMatch(/\d+ checks? unavailable/);
    },
    WHOLE_REPO_VALIDATE_MS,
  );
});

describe("every skip in the validator is classified, so a new one cannot default quietly", () => {
  /**
   * The population this check owns: every `skipped(` and `unavailable(` call in
   * `src/`, by the rule id each reports under.
   *
   * A grep rather than a run, deliberately. Reaching these sites by running the
   * validator needs a tree shaped to defeat each one, and a site no fixture
   * reaches would be missing from the population without anything saying so --
   * which is the failure this check exists to prevent one level down.
   */
  const CALL = /(?<![\w.])(skipped|unavailable)\(\s*"([\w.-]+)"/g;

  /**
   * Every skip site in `src/`, as `rule -> the kinds it is reported under`.
   *
   * A list and not a single kind, because one rule legitimately reports both:
   * `defects.contract-unreadable` blocks when open entries went unexamined and
   * does not when there were none. Keyed by rule alone, the second site would
   * have overwritten the first and the table would have looked complete.
   */
  const CLASSIFIED: Record<string, Array<"skipped" | "unavailable">> = {
    // Subject absent: the material is not in the tree, so empty is correct.
    // These are other lanes' checks and are left as their authors classified
    // them. Several look like the authority-absent shape from the outside and
    // are flagged to their owners rather than reclassified from here -- moving
    // a check into the blocking set is a change to what `ak validate` fails on,
    // which is not a call to make inside someone else's lane.
    "provenance.donors-unavailable": ["skipped"],
    "provenance.local-source-unavailable": ["skipped"],
    "provenance.transcript-unavailable": ["skipped"],
    "provenance.plan-unavailable": ["skipped"],
    "provenance.plan-scenarios-unavailable": ["skipped"],
    "provenance.rationale-plan-unavailable": ["skipped"],
    "provenance.conversation-map-unavailable": ["skipped"],
    "schemas.validator-unavailable": ["skipped"],
    "partition.policy-unreadable": ["skipped"],
    "partition.closure-unavailable": ["skipped"],
    "sideeffects.policy-unavailable": ["skipped"],
    "sideeffects.manifest-unavailable": ["skipped"],
    "sideeffects.vocabulary-unavailable": ["skipped"],
    // Authority absent while the subject is present: these block.
    "role.mandated-rows-unavailable": ["unavailable"],
    // Both host manifests are in the plan, carrying the four fields
    // `adapters/codex/CONTRACT.md` §5.2 makes them agree with `package.json`
    // on. Absent, unparseable, or silent about one of the four, package.json is
    // the authority that went missing and the manifests are the subject sitting
    // in front of the check. A non-blocking skip here would let a tree with no
    // package.json build green over a comparison nobody made.
    "packaging.manifest-parity-unavailable": ["unavailable"],
    // Every skill's `packaging.hosts[]` mode is in the plan; §3's capability
    // table is the authority those modes are measured against. Absent, no
    // ceiling is computed for any of them -- and a non-blocking skip here would
    // let a tree with no host contract build green over a comparison nobody
    // made, reporting the same clean result as a tree that genuinely checked
    // out. That is the same argument as the row above it.
    "packaging.capability-table-unavailable": ["unavailable"],
    // The bodies are all in the tree; the policy that says which ruling ids
    // exist is what could not be read, so no citation in any of them was
    // checked. The row checks at the same seam stay out of this table: their
    // subject is the rows, and with no rows there is nothing unexamined.
    "rulings.citations-unavailable": ["unavailable"],
    // `unavailable` and not `skipped` for the same reason as the line above: the
    // subject is present -- all nineteen rows are in the policy -- and what is
    // missing is the vocabulary they are measured against. A row check whose
    // subject had gone missing would stay out of this table entirely.
    "rulings.discharge-vocabulary-unavailable": ["unavailable"],
    // The same shape again: the profiles' capability lists are in the tree, and
    // the vocabulary they are measured against is what could not be read.
    "profile.capability-vocabulary-unavailable": ["unavailable"],
    // Both, and which one depends on whether any open entry went unexamined.
    "defects.contract-unreadable": ["skipped", "unavailable"],
    // The record names a registry in another repository or a package, so the
    // articles are not in reach of the run: the subject is what is missing.
    "constitution.registry-not-local": ["skipped"],
    // The registry is in reach and the schemas it is judged against did not
    // compile: the subject is present and its authority is not.
    "constitution.schema-unavailable": ["unavailable"],
  };

  /** Every `rule -> kinds` pair actually written in `src/`, sorted for comparison. */
  function sitesIn(dir: string): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const walk = (at: string) => {
      for (const name of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, name.name);
        if (name.isDirectory()) {
          walk(path);
          continue;
        }
        if (!name.name.endsWith(".ts") || name.name === "types.ts") continue;
        for (const match of readFileSync(path, "utf8").matchAll(CALL)) {
          const rule = match[2] ?? "";
          const kind = match[1] ?? "";
          const kinds = found.get(rule) ?? [];
          if (!kinds.includes(kind)) kinds.push(kind);
          found.set(rule, kinds.sort());
        }
      }
    };
    walk(dir);
    return found;
  }

  const SRC = join(import.meta.dir, "..", "src");

  test("every call site's rule appears in the table above, under every kind it uses", () => {
    const found = sitesIn(SRC);
    expect(found.size).toBeGreaterThan(0);

    expect([...found.keys()].filter((rule) => CLASSIFIED[rule] === undefined)).toEqual([]);

    // Compared as sets, so a rule that gains a second kind fails here rather
    // than passing on the strength of the kind it already had.
    const miscategorised = found
      .entries()
      .filter(([rule, kinds]) => JSON.stringify(CLASSIFIED[rule]?.slice().sort()) !== JSON.stringify(kinds))
      .map(([rule, kinds]) => `${rule}: ${kinds.join("+")}`)
      .toArray();
    expect(miscategorised).toEqual([]);
  });

  test("the table names nothing that is no longer in the tree", () => {
    // The other direction. A stale row would let a deleted check go on looking
    // classified, and this table is the only place the classification is written.
    const found = sitesIn(SRC);
    expect(Object.keys(CLASSIFIED).filter((rule) => !found.has(rule))).toEqual([]);
  });

  test("at least one site of each kind exists, so neither branch is vacuously satisfied", () => {
    const kinds = new Set([...sitesIn(SRC).values()].flat());
    expect([...kinds].sort()).toEqual(["skipped", "unavailable"]);
  });
});
