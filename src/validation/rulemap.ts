import { readdirSync } from "node:fs";
import { join } from "node:path";

import { readTextIfPresent } from "../util/fs.ts";
import type { CheckContext } from "./context.ts";
import { error, note, warning, type Issue } from "./types.ts";

/**
 * Schema rule ids to the rule ids `ak validate` reports for them.
 *
 * Every JSON Schema under schemas/ tags the constraints it cannot state in
 * JSON Schema with an `x-validator-rule` key. That key is a contract with this
 * tool: the schema author writes the rule down, and the validator enforces it.
 * The map below is the receipt for that contract, and `checkSchemaRuleCoverage`
 * turns it into a check -- a rule a schema author adds and nobody implements
 * fails validation instead of passing silently.
 *
 * Most rules are reported under their own id. The rest were implemented before
 * the schemas named them and kept the id an author already sees in the output;
 * those entries name the ids actually emitted, so the mapping stays greppable
 * in both directions.
 */
/**
 * Either the rule ids `ak validate` reports for a schema rule, or an explicit
 * declaration that it is not implemented yet. A pending rule is reported as a
 * warning on every run: pending is acceptable, invisible is not.
 */
export interface PendingRule {
  readonly status: "not-implemented";
  readonly reason: string;
}

export type RuleImplementation = ReadonlyArray<string> | PendingRule;

export function isPending(value: RuleImplementation): value is PendingRule {
  return !Array.isArray(value);
}

export const SCHEMA_RULE_IMPLEMENTATIONS: Readonly<Record<string, RuleImplementation>> = {
  // catalog.schema.json
  "catalog.ids-unique-across-all-sections-and-every-entry-has-a-directory": [
    "catalog.ids-unique-across-all-sections-and-every-entry-has-a-directory",
  ],
  "catalog.invocation-graph-user-invoked-never-calls-user-invoked": [
    "invocation.u-calls-u",
    "invocation.model-starts-user-skill",
    "invocation.undeclared-operation",
    "invocation.operation-not-delegated",
    "invocation.unknown-target",
  ],
  "catalog.reference-loaded-by-names-a-declared-skill": ["catalog.reference-loaded-by-names-a-declared-skill"],
  "catalog.schema-entry-has-a-file-and-every-file-has-an-entry": [
    "catalog.entry-without-file",
    "catalog.file-without-entry",
  ],
  "catalog.exactly-one-default-profile-matching-package-default-profile": [
    "catalog.exactly-one-default-profile-matching-package-default-profile",
  ],

  // charter.schema.json
  "charter.hash-matches-content-and-location-is-not-worker-writable": [
    "charter.hash-matches-content-and-location-is-not-worker-writable",
  ],
  "charter.sensitive-grant-requires-explicit-human-approval-bound-to-this-hash": [
    "charter.sensitive-grant-requires-explicit-human-approval-bound-to-this-hash",
  ],
  "charter.supervisor-seats-independent-and-not-the-implementer": [
    "charter.supervisor-seats-independent-and-not-the-implementer",
  ],
  "charter.amendment-creates-a-new-hash-and-invalidates-old-grants": [
    "charter.amendment-creates-a-new-hash-and-invalidates-old-grants",
  ],

  // common.schema.json
  //
  // The enum itself is ordinary JSON Schema. What the schema cannot state is the
  // constraint the tag names: that every row of policies/resolved-conflicts.yaml
  // declares one of those values. No schema is applied to policies/, so that
  // requirement lives in rulings.ts, which reads the enum rather than restating it.
  "common.ruling-declares-a-discharging-skill-section": [
    "rulings.missing-discharged-in",
    "rulings.malformed-discharged-in",
    "rulings.unknown-discharged-in",
  ],

  // decision.schema.json
  "decision.seats-declared-independent-and-not-the-implementer": [
    "decision.seats-declared-independent-and-not-the-implementer",
  ],
  "decision.judgment-choice-names-a-declared-option": ["decision.judgment-choice-names-a-declared-option"],
  "decision.agreement-matches-the-recorded-judgments": ["decision.agreement-matches-the-recorded-judgments"],
  "decision.authority-check-recomputed-from-charter-and-evidence": [
    "decision.authority-check-recomputed-from-charter-and-evidence",
  ],
  "decision.ruling-requires-a-passed-authority-check-not-mere-agreement": [
    "decision.ruling-requires-a-passed-authority-check-not-mere-agreement",
  ],

  // dossier.schema.json
  "dossier.turns-used-within-turns-allowed": ["dossier.turns-used-within-turns-allowed"],
  "dossier.lexical-baseline-present": ["dossier.lexical-baseline-present"],
  "dossier.stale-or-absent-graph-documents-a-limitation": ["dossier.stale-or-absent-graph-documents-a-limitation"],
  "dossier.no-architectural-verdict": ["dossier.no-architectural-verdict"],
  "dossier.index-revision-compared-to-source-revision": ["dossier.index-revision-compared-to-source-revision"],

  // event.schema.json
  "event.no-event-field-confers-authority": ["event.no-event-field-confers-authority"],
  "event.remote-side-effect-key-is-unique-and-read-back": ["event.remote-side-effect-key-is-unique-and-read-back"],

  // finding.schema.json
  "finding.fingerprint-stable-across-line-moves": ["finding.fingerprint-stable-across-line-moves"],
  "finding.evidence-digest-domain": ["finding.evidence-digest-domain"],
  "finding.presentation-label-never-substitutes-for-severity": [
    "finding.presentation-label-never-substitutes-for-severity",
  ],
  // Narrowed on purpose, and the narrowing is the record. `finding.self-closed`
  // enforces one half of this tag: the closer is not the author of the finding.
  // The other half -- not the author of the *change* -- was implemented against
  // `fix_author` and `fix.author`, which finding.schema.json declares nowhere,
  // so it never fired on a conforming document. It is held by the
  // `apply-findings` protocol instead of by a field on the finding, because a
  // finding would carry that field empty until something else backfilled it.
  // Not pending and not unimplemented: relocated. See src/validation/artifacts.ts.
  "finding.closer-is-not-the-author-of-the-change": ["finding.self-closed"],
  "finding.synthesis-may-only-worsen-a-grade": ["finding.synthesis-may-only-worsen-a-grade"],
  "finding.low-confidence-security-is-adjudicated-not-filtered": [
    "finding.low-confidence-security-is-adjudicated-not-filtered",
  ],

  // install.schema.json
  "install.attached-names-an-attachable-adapter": ["packaging.install-unknown-adapter"],
  "install.backend-names-an-attached-adapter": ["packaging.install-backend-unattached"],

  // lesson.schema.json
  "lesson.duplicate-of-an-existing-lesson-is-refused": ["lesson.duplicate-of-an-existing-lesson-is-refused"],
  "lesson.skill-rollback-preserves-lesson-and-evidence-history": [
    "lesson.skill-rollback-preserves-lesson-and-evidence-history",
  ],

  // pack.schema.json
  "pack.activation-requires-artifact-and-semantics": ["pack.activation-requires-artifact-and-semantics"],
  "pack.attachment-records-rationale-and-matched-rule": ["pack.attachment-records-rationale-and-matched-rule"],
  "pack.provenance-donor-path-exists-at-pin": [
    "provenance.source-not-at-pin",
    "provenance.unknown-donor",
    "provenance.commit-not-pinned",
    "provenance.malformed-source",
  ],

  // constitution-article.schema.json -- checked only on a registry a project
  // record names (`ak validate --project`).
  "constitution-article.file-named-by-id": ["constitution.article-file-name"],
  "constitution-article.source-span-resolves": ["constitution.source-span-unresolved"],
  "constitution-article.related-ids-resolve-and-tie-breakers-do-not-cycle": [
    "constitution.unknown-related-id",
    "constitution.tie-breaker-cycle",
  ],
  "constitution-article.obligation-ids-unique": ["constitution.duplicate-obligation-id"],
  "constitution-article.covers-names-an-obligation": ["constitution.unknown-obligation"],

  // plan-record.schema.json
  "plan-record.specification-approval-binds-to-the-specification-hash": [
    "plan-record.specification-hash-mismatch",
    "approval.stale",
  ],

  // project.schema.json
  "project.kb-root-is-not-an-application-local-docs-tree": ["project.kb-root-is-not-an-application-local-docs-tree"],
  "project.standards-path-resolves-or-lane-returns-empty": ["project.standards-path-resolves-or-lane-returns-empty"],
  "project.numeric-guidance-never-becomes-a-gate": ["project.numeric-guidance-never-becomes-a-gate"],
  "project.test-pyramid-percentages-sum-to-100": ["project.test-pyramid-percentages-sum-to-100"],
  "project.single-tracker-system-of-record": ["project.single-tracker-system-of-record"],

  // review.schema.json
  "review.security-seat-not-filled-by-implementer-or-spec-approver": [
    "review.security-seat-not-filled-by-implementer-or-spec-approver",
  ],
  "review.delta-scope-bounded-by-affected-behavior": ["review.delta-scope-bounded-by-affected-behavior"],
  "review.third-fix-cycle-stops": ["review.third-fix-cycle-stops"],
  "review.material-change-establishes-a-new-baseline": ["review.material-change-establishes-a-new-baseline"],
  "review.unavailable-required-lane-blocks-approval": ["review.unavailable-required-lane-blocks-approval"],
  "review.seat-filled-by-someone-other-than-the-author": ["review.seat-filled-by-someone-other-than-the-author"],

  // skill.schema.json
  "skill.user-invoked-never-starts-user-invoked": ["skill.user-invoked-never-starts-user-invoked"],
  "skill.budget-enforces-only-declared-limits": ["skill.budget-enforces-only-declared-limits"],
  "skill.model-operation-is-model-authority-and-callable": [
    "invocation.model-operation-not-model",
    "invocation.model-operation-not-callable",
    "invocation.undeclared-operation",
  ],
  "skill.host-frontmatter-generated-never-authored": ["frontmatter.host-key-in-canonical"],
  "skill.body-within-line-budget": ["budget.skill-over-target", "budget.skill-over-cap"],
  "skill.provenance-donor-path-exists-at-pin": [
    "provenance.source-not-at-pin",
    "provenance.unknown-donor",
    "provenance.commit-not-pinned",
    "provenance.malformed-source",
  ],

  // tracker-binding.schema.json
  "tracker-binding.secret-is-ignored-untracked-and-never-committed": [
    "tracker.secret-outside-project",
    "tracker.secret-tracked",
    "tracker.secret-not-ignored",
    "tracker.secret-in-history",
  ],

  // verification.schema.json
  "verification.receipt-stale-when-revision-differs-from-head": [
    "verification.receipt-stale-when-revision-differs-from-head",
  ],
  "verification.prose-never-substitutes-for-exit-status-and-digest": [
    "verification.prose-never-substitutes-for-exit-status-and-digest",
  ],
  "verification.weakened-check-requires-its-own-decision": ["verification.weakened-check-requires-its-own-decision"],
};

const SCHEMA_DIR = "schemas";

/** Collect every `x-validator-rule` value in a parsed schema document. */
export function collectValidatorRules(node: unknown, into: Set<string>): Set<string> {
  if (node === null || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const child of node) collectValidatorRules(child, into);
    return into;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "x-validator-rule") {
      // A schema may name one rule or several at the same point.
      if (typeof value === "string") into.add(value);
      else if (Array.isArray(value)) for (const one of value) if (typeof one === "string") into.add(one);
      continue;
    }
    collectValidatorRules(value, into);
  }
  return into;
}

/**
 * The schemas are authored concurrently with this tool. A rule id that appears
 * there and nowhere here is an unenforced constraint, which is worse than a
 * loud failure: the tree would validate clean while the contract went
 * unchecked.
 */
export function checkSchemaRuleCoverage(ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  let names: string[];
  try {
    names = readdirSync(join(ctx.root, SCHEMA_DIR))
      .filter((n) => n.endsWith(".schema.json"))
      .sort();
  } catch {
    issues.push(
      note(
        "schemas.directory-unavailable",
        SCHEMA_DIR,
        `No ${SCHEMA_DIR}/ directory; x-validator-rule coverage was not checked.`,
      ),
    );
    return issues;
  }

  const found = new Map<string, string>();
  for (const name of names) {
    const file = `${SCHEMA_DIR}/${name}`;
    const text = readTextIfPresent(join(ctx.root, file));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // checkSchemas owns unparseable schemas.
    }
    for (const rule of collectValidatorRules(parsed, new Set<string>())) {
      if (!found.has(rule)) found.set(rule, file);
    }
  }

  let implemented = 0;
  let pending = 0;
  for (const [rule, file] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = SCHEMA_RULE_IMPLEMENTATIONS[rule];
    if (entry === undefined) {
      issues.push(
        error(
          "schemas.unimplemented-validator-rule",
          file,
          `x-validator-rule '${rule}' has no entry in ak validate's registry. Add the rule id the checker reports, or declare it { status: "not-implemented", reason }; an annotation with neither is documentation of a check that does not run.`,
        ),
      );
      continue;
    }
    if (isPending(entry)) {
      pending += 1;
      issues.push(
        warning(
          "schemas.validator-rule-pending",
          file,
          `x-validator-rule '${rule}' is declared not-implemented: ${entry.reason}`,
        ),
      );
      continue;
    }
    implemented += 1;
  }

  if (found.size > 0) {
    issues.push(
      note(
        "schemas.validator-rule-coverage",
        SCHEMA_DIR,
        `${found.size} rules, ${implemented} implemented, ${pending} declared pending.`,
      ),
    );
  }

  return issues;
}
