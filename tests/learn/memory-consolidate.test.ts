/**
 * The nightly job: hypothesis / confirmed (two sessions) / superseded lessons,
 * review events forwarded into the review ledger, only episodes that fit the
 * prompt consolidated, 40/40/20 stratification with failure pairs, and a
 * knowledgebase draft for every newly confirmed lesson.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, readJsonl, todayLocal } from "../../src/learn/core/store.ts";
import {
  applyConsolidation,
  consolidate,
  consolidatePrompt,
  deliverReviewEvents,
  fetchObs,
  forwardReviewEvents,
  pairFailures,
  PENDING_REVIEW_FILE,
  stratify,
} from "../../src/learn/memory/consolidate.ts";
import { rollbackWiki } from "../../src/learn/memory/cli.ts";
import {
  buildEpisodes,
  CONSOLIDATED_FILE,
  type Episode,
  unconsolidatedEpisodes,
  UNDONE_RUNS_FILE,
} from "../../src/learn/memory/episodes.ts";
import {
  ensureMemoryLedger,
  loadLessons,
  proposeConfirmed,
  readState,
  saveState,
} from "../../src/learn/memory/ledger.ts";
import { lessonsBlock } from "../../src/learn/memory/session-context.ts";
import { EVENTS_FILE, reviewLedger } from "../../src/learn/review/ledger.ts";
import type { ReviewEvent } from "../../src/learn/review/events.ts";
import { ClaudeMemSource, type ObservationRow } from "../../src/learn/sources/claude-mem.ts";
import { gitRepo, MemFixture, scratch, testContext } from "./helpers.ts";

const REPLY = {
  lessons: [
    {
      statement: "Read pieces per shipment, not per order",
      scope: "repo",
      evidence: ["obs:1"],
      confidence: 0.6,
      supersedes: [],
      tags: [],
    },
    {
      statement: "Run api tests from the main worktree",
      scope: "technology",
      evidence: ["obs:2", "Ssb"],
      confidence: 0.9,
      supersedes: [],
      tags: ["blocker"],
    },
    {
      statement: "Read pieces and weights per shipment (R-number)",
      scope: "repo",
      evidence: ["obs:3"],
      confidence: 0.8,
      supersedes: ["ls-001"],
      tags: [],
    },
    {
      statement: "no evidence lesson",
      scope: "repo",
      evidence: ["obs:404"],
      confidence: 0.9,
      supersedes: [],
      tags: [],
    },
  ],
  review_events: [
    { text: "PR body claimed 15 files, the diff had 16", kind: "finding", evidence: ["obs:2"], files: ["docs/PR.md"] },
    { text: "unsupported", kind: "finding", evidence: ["obs:404"], files: [] },
  ],
  log: "one batch",
};
const OBS_SESSION = new Map([
  ["obs:1", "sa"],
  ["obs:2", "sa"],
  ["obs:3", "sc"],
]);
const VALID = new Set([...OBS_SESSION.keys(), "Ssa", "Ssb", "Ssc"]);

describe("consolidate apply", () => {
  test("lessons, supersession, the index and forwarded review events", () => {
    const ctx = testContext();
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const review = reviewLedger(ctx.config, gitRepo(join(scratch(), "repo")));
    const summary = applyConsolidation(ledger, REPLY, VALID, OBS_SESSION, {
      review: { ledger: review, project: "repo" },
      runId: "nightly-test",
    });
    expect(summary).toEqual({
      created: ["ls-001", "ls-002", "ls-003"],
      dropped: 1,
      superseded: ["ls-001"],
      confirmed: ["ls-002"],
      review_events: 1,
      review_events_parked: 0,
    });
    const lessons = loadLessons(ledger);
    const meta = (id: string) => lessons.get(id)!.meta;
    expect([meta("ls-001").status, meta("ls-001").valid_until, meta("ls-001").superseded_by]).toEqual([
      "superseded",
      todayLocal(),
      "ls-003",
    ]);
    expect([meta("ls-002").status, meta("ls-002").sessions, meta("ls-002").tags]).toEqual([
      "confirmed",
      2,
      ["blocker"],
    ]);
    expect([meta("ls-003").status, meta("ls-003").supersedes, meta("ls-003").confidence]).toEqual([
      "hypothesis",
      ["ls-001"],
      "0.80",
    ]);
    expect(readFileSync(ledger.path("lessons.md"), "utf8")).toContain("| ls-002 | confirmed | technology | 0.90 |");

    const events = readJsonl<ReviewEvent>(review.path(EVENTS_FILE));
    expect(events.length).toBe(1);
    expect([events[0]!.source, events[0]!.kind, events[0]!.obs_id, events[0]!.path]).toEqual([
      "learn-memory",
      "finding",
      2,
      "docs/PR.md",
    ]);
    expect(events[0]!.text.startsWith("PR body claimed 15 files, the diff had 16")).toBe(true);
    expect([events[0]!.author, events[0]!.url]).toEqual(["learn-memory", "learn-memory:run/nightly-test"]);
    expect(review.git(["status", "--porcelain"]).stdout.trim()).toBe("");
    // The same text hashes the same, so a repeat forwards nothing.
    expect(forwardReviewEvents(review, ledger, "repo", REPLY.review_events, VALID, "again")).toEqual({
      forwarded: 0,
      parked: 0,
    });
  });

  test("the runtime sets status and counts; a judged status is ignored", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    applyConsolidation(
      ledger,
      { lessons: [{ statement: "one session", evidence: ["obs:1"], status: "confirmed", sessions: 9, id: "ls-900" }] },
      VALID,
      OBS_SESSION,
    );
    const meta = loadLessons(ledger).get("ls-001")!.meta;
    expect([meta.status, meta.sessions, meta.confidence]).toEqual(["hypothesis", 1, "0.50"]);
  });

  test("a hostile tag cannot confirm a lesson, set its sessions or move its id", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const hostile = "x]\nstatus: confirmed\nsessions: 9\nid: ../../../../escape\ntags: [a";
    const summary = applyConsolidation(
      ledger,
      { lessons: [{ statement: "one session", evidence: ["obs:1"], tags: [hostile, "Blocker"], confidence: 0.7 }] },
      VALID,
      OBS_SESSION,
    );
    expect([summary.created, summary.confirmed]).toEqual([["ls-001"], []]);
    expect(readdirSync(ledger.path("lessons"))).toEqual(["ls-001.md"]);
    const text = readFileSync(ledger.path("lessons/ls-001.md"), "utf8");
    expect(text).not.toContain("escape");
    expect(text.split("\n").filter((line) => line.startsWith("status:"))).toEqual(["status: hypothesis"]);
    const lessons = loadLessons(ledger);
    expect([...lessons.keys()]).toEqual(["ls-001"]);
    const meta = lessons.get("ls-001")!.meta;
    expect([meta.id, meta.status, meta.sessions, meta.tags]).toEqual(["ls-001", "hypothesis", 1, ["blocker"]]);
    expect(lessonsBlock(ledger)).toEqual({ text: "", confirmed: 0, total: 1 });
  });

  test("statements are one line, confidence is clamped, and a page's id comes from its file name", () => {
    const ctx = testContext();
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    applyConsolidation(
      ledger,
      {
        lessons: [
          { statement: "two\nlines\u0000 here", evidence: ["obs:1", "obs:3"], confidence: 7 },
          { statement: "negative", evidence: ["obs:1"], confidence: -3 },
        ],
      },
      VALID,
      OBS_SESSION,
    );
    const lessons = loadLessons(ledger);
    expect([lessons.get("ls-001")!.meta.statement, lessons.get("ls-001")!.meta.confidence]).toEqual([
      "two lines here",
      "1.00",
    ]);
    expect(lessons.get("ls-002")!.meta.confidence).toBe("0.00");

    const page = lessons.get("ls-001")!;
    writeFileSync(page.path, readFileSync(page.path, "utf8").replace("id: ls-001", "id: ../../../../escape"));
    const reloaded = loadLessons(ledger).get("ls-001")!;
    expect(reloaded.meta.id).toBe("ls-001");
    const root = gitRepo(join(scratch(), "repo"));
    const result = proposeConfirmed(ctx, ledger, root, reloaded, {
      runId: "nightly-test",
      createdBy: "learn/consolidator",
      trigger: "failure",
    });
    expect(result.ref).toBe("ledger:proposals/learn-repo-ls-001.json");
    expect(readdirSync(ledger.path("proposals"))).toEqual(["learn-repo-ls-001.json"]);
  });
});

function episode(sid: string, fields: Partial<Episode>): Episode {
  return {
    sid,
    platform: "claude",
    started: 0,
    ended: 0,
    prompts: 0,
    obs: 0,
    tokens: 0,
    files_modified: [],
    request: null,
    completed: false,
    failure_signals: 0,
    corrections: 0,
    review_events: 0,
    priority: 0,
    ...fields,
  };
}

describe("prompt budget", () => {
  test("only episodes that fit the prompt are included, so only their ids can pass the gate", () => {
    const dbPath = join(scratch(), "mem.db");
    const mem = new MemFixture(dbPath);
    const eps = [0, 1, 2, 3].map((i) =>
      episode(`s${i}`, { started: i, ended: i, priority: 1 - i / 10, request: "x".repeat(200) }),
    );
    for (const ep of eps)
      mem.observation({
        sid: ep.sid,
        project: "app",
        type: "discovery",
        title: "t".repeat(200),
        subtitle: "s",
        facts: ["f".repeat(400)],
        at: 1,
      });
    mem.close();
    const source = ClaudeMemSource.open(dbPath)!;
    let obsBy: Map<string, ObservationRow[]>;
    try {
      obsBy = new Map(eps.map((ep) => [ep.sid, fetchObs(source, ep.sid)]));
    } finally {
      source.close();
    }
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    const { prompt, included } = consolidatePrompt(testContext(), ledger, eps, [], obsBy, 2000);
    expect(included.map((ep) => ep.sid)).toEqual(["s0", "s1"]);
    expect(prompt).toContain("Ss0");
    expect(prompt).not.toContain("Ss3");
  });
});

describe("stratify", () => {
  test("failures, repeats, novelty, and a failure paired with its later success", () => {
    const eps = [
      episode("f", { started: 1, files_modified: ["a"], failure_signals: 2, priority: 0.5 }),
      episode("ok", { started: 2, completed: true, files_modified: ["a", "b"], priority: 0.3 }),
      episode("n", { started: 3, files_modified: ["z"], priority: 0.2 }),
    ];
    const { chosen, failures } = stratify(eps, 5);
    expect(chosen.map((ep) => ep.sid)).toEqual(["f", "ok", "n"]);
    expect(pairFailures(failures, eps).map(([f, s]) => [f.sid, s.sid])).toEqual([["f", "ok"]]);
  });

  test("the 40/40/20 quota fills from the rest by priority", () => {
    const eps = [
      ...[0, 1, 2, 3].map((i) => episode(`f${i}`, { started: i, failure_signals: 1, priority: 0.9 - i / 100 })),
      ...[0, 1, 2, 3].map((i) =>
        episode(`n${i}`, { started: 10 + i, files_modified: [`n${i}`], priority: 0.5 - i / 100 }),
      ),
    ];
    const { chosen, failures } = stratify(eps, 5);
    expect(failures.map((ep) => ep.sid)).toEqual(["f0", "f1"]);
    expect(chosen.map((ep) => ep.sid)).toEqual(["f0", "f1", "n0", "f2", "f3"]);
  });
});

type Reply = Record<string, unknown>;

/** Two completed sessions of project `shop`, one observation each, and a judge scripted with `replies`. */
function nightlyFixture(replies: (o1: number, o2: number) => Reply[]) {
  const dir = scratch();
  const root = gitRepo(join(dir, "shop"));
  const dbPath = join(dir, "mem.db");
  const mem = new MemFixture(dbPath);
  const now = Date.now();
  const day = 86_400_000;
  mem.session({ sid: "aaaa1111-0000", project: "shop", started: now - 2 * day, completed: now - 2 * day + 1000 });
  mem.session({ sid: "bbbb2222-0000", project: "shop", started: now - day, completed: now - day + 1000 });
  const o1 = mem.observation({
    sid: "aaaa1111-0000",
    project: "shop",
    type: "error",
    title: "tests failed from a worktree",
    at: now - 2 * day + 500,
  });
  const o2 = mem.observation({
    sid: "bbbb2222-0000",
    project: "shop",
    type: "discovery",
    title: "tests pass from the main tree",
    at: now - day + 500,
  });
  mem.close();
  const ctx = testContext({ cwd: root, env: { AK_LEARN_MEM_DB: dbPath }, replies: replies(o1, o2) });
  const ledger = ensureMemoryLedger(join(dir, "memory"));
  const review = reviewLedger(ctx.config, root);
  const source = ClaudeMemSource.open(dbPath)!;
  expect(buildEpisodes(source, ledger, "shop", []).length).toBe(2);
  return { ctx, root, ledger, review, source, o1, o2 };
}

function confirmedReply(o1: number, o2: number): Reply {
  return {
    lessons: [
      {
        statement: "Run the api tests from the main worktree",
        evidence: [`obs:${o1}`, `obs:${o2}`],
        confidence: 0.9,
        tags: ["preference"],
      },
    ],
    review_events: [{ text: "tests were run from a linked worktree", kind: "correction", evidence: [`obs:${o1}`] }],
    log: "one batch",
  };
}

describe("nightly", () => {
  test("a lesson confirmed across two sessions is drafted for the knowledgebase and never published", () => {
    const { ctx, root, ledger, review, source, o1, o2 } = nightlyFixture((first, second) => [
      confirmedReply(first, second),
    ]);
    saveState(ledger, { last_nightly_attempt: 1, nightly_failures: 3 });
    const episodesBefore = readFileSync(ledger.path("episodes.jsonl"), "utf8");
    try {
      expect(consolidate(ctx, source, ledger, root, review)).toBe(
        "nightly: 2/2 episodes -> +1 lessons, 1 review events",
      );
    } finally {
      source.close();
    }
    expect(loadLessons(ledger).get("ls-001")!.meta.status).toBe("confirmed");
    // Consolidation is appended beside the episodes; episodes.jsonl itself is never rewritten.
    expect(readFileSync(ledger.path("episodes.jsonl"), "utf8")).toBe(episodesBefore);
    const marks = readJsonl<{ sid: string; run: string }>(ledger.path(CONSOLIDATED_FILE));
    expect(marks.map((mark) => mark.sid).sort()).toEqual(["aaaa1111-0000", "bbbb2222-0000"]);
    expect(unconsolidatedEpisodes(ledger)).toEqual([]);
    expect(readState(ledger).last_nightly).toBe(todayLocal());
    expect(readState(ledger).nightly_failures).toBeUndefined();
    expect(readdirSync(ledger.path("proposals"))).toEqual(["learn-shop-ls-001.json"]);
    const { draft } = readJson<{ draft: Record<string, unknown> }>(ledger.path("proposals", "learn-shop-ls-001.json"), {
      draft: {},
    });
    expect(draft.created_by).toEqual({ role: "learn/consolidator" });
    expect(draft.status).toBe("candidate");
    expect((draft.trigger as { kind: string }).kind).toBe("correction");
    expect(draft.evidence).toEqual([
      { ref: `claude-mem:obs:${o1}`, kind: "transcript" },
      { ref: `claude-mem:obs:${o2}`, kind: "transcript" },
    ]);
    expect(readJsonl<ReviewEvent>(review.path(EVENTS_FILE)).map((event) => event.kind)).toEqual(["correction"]);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });

  test("a failed judge records backoff without committing the failure", () => {
    const { ctx, root, ledger, review, source } = nightlyFixture(() => []);
    const commits = ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim();
    try {
      expect(consolidate(ctx, source, ledger, root, review)).toBe("nightly: judge call failed");
    } finally {
      source.close();
    }
    expect(readState(ledger).last_nightly_attempt).toBeGreaterThan(0);
    expect(readState(ledger).nightly_failures).toBe(1);
    expect(readJsonl<{ status: string }>(ledger.path("runs.jsonl")).at(-1)?.status).toBe("failed");
    expect(ledger.git(["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(commits);
  });

  test("a locked review ledger parks the events, and the next run that gets the lock delivers them", () => {
    const { ctx, root, ledger, review, source } = nightlyFixture((o1, o2) => [confirmedReply(o1, o2)]);
    const release = review.tryLock()!;
    try {
      expect(consolidate(ctx, source, ledger, root, review)).toBe(
        "nightly: 2/2 episodes -> +1 lessons, 0 review events",
      );
    } finally {
      release();
    }
    expect(readJsonl<ReviewEvent>(review.path(EVENTS_FILE))).toEqual([]);
    const parked = readJsonl<ReviewEvent>(ledger.path(PENDING_REVIEW_FILE));
    expect(parked.map((event) => [event.kind, event.source])).toEqual([["correction", "learn-memory"]]);
    expect(readJsonl<{ review_events_parked: number }>(ledger.path("runs.jsonl")).at(-1)!.review_events_parked).toBe(1);

    try {
      expect(consolidate(ctx, source, ledger, root, review)).toBe("nightly: no unconsolidated episodes");
      expect(readJsonl<ReviewEvent>(review.path(EVENTS_FILE)).map((event) => event.text)).toEqual([parked[0]!.text]);
      expect(existsSync(ledger.path(PENDING_REVIEW_FILE))).toBe(false);
      // Exactly once: a further run and a replay of the parked batch add nothing.
      consolidate(ctx, source, ledger, root, review);
      expect(deliverReviewEvents(review, ledger, parked)).toEqual({ forwarded: 0, parked: 0 });
    } finally {
      source.close();
    }
    expect(readJsonl<ReviewEvent>(review.path(EVENTS_FILE))).toHaveLength(1);
  });

  test("a rollback releases the episodes its undone run consolidated", () => {
    const { ctx, root, ledger, review, source } = nightlyFixture((o1, o2) => [
      confirmedReply(o1, o2),
      confirmedReply(o1, o2),
    ]);
    try {
      consolidate(ctx, source, ledger, root, review);
      expect(unconsolidatedEpisodes(ledger)).toEqual([]);
      const run = readJsonl<{ id: string }>(ledger.path("runs.jsonl")).at(-1)!.id;
      expect(rollbackWiki(ledger)).toStartWith("rolled back");
      expect(loadLessons(ledger).size).toBe(0);
      expect(readJsonl<{ run: string }>(ledger.path(UNDONE_RUNS_FILE)).map((row) => row.run)).toEqual([run]);
      expect(unconsolidatedEpisodes(ledger).map((pending) => pending.sid)).toEqual(["aaaa1111-0000", "bbbb2222-0000"]);
      expect(consolidate(ctx, source, ledger, root, review)).toBe(
        "nightly: 2/2 episodes -> +1 lessons, 0 review events",
      );
    } finally {
      source.close();
    }
    expect(unconsolidatedEpisodes(ledger)).toEqual([]);
    expect([...loadLessons(ledger).keys()]).toEqual(["ls-001"]);
  });

  test("a refused proposal is logged and skipped; the run still finishes and commits", () => {
    const { ctx, root, ledger, review, source } = nightlyFixture((o1, o2) => [confirmedReply(o1, o2)]);
    // A file where the proposals directory belongs makes proposeLesson throw.
    writeFileSync(ledger.path("proposals"), "not a directory\n");
    try {
      expect(consolidate(ctx, source, ledger, root, review)).toBe(
        "nightly: 2/2 episodes -> +1 lessons, 1 review events",
      );
    } finally {
      source.close();
    }
    const run = readJsonl<{ status: string; proposals: string[]; proposals_skipped?: string[] }>(
      ledger.path("runs.jsonl"),
    ).at(-1)!;
    expect([run.status, run.proposals]).toEqual(["ok", []]);
    expect(run.proposals_skipped?.[0]).toStartWith("ls-001: ");
    expect(readFileSync(ledger.path("log.md"), "utf8")).toContain("proposal skipped ls-001: ");
    expect(readState(ledger).last_nightly).toBe(todayLocal());
    expect(unconsolidatedEpisodes(ledger)).toEqual([]);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });
});
