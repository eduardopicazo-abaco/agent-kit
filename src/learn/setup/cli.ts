/**
 * `ak learn setup` — install, check and remove the learning runtime's host wiring.
 * Every verb prints what it changed and is safe to re-run.
 */
import { flag, type LearnArea, type LearnContext } from "../core/context.ts";
import { doctor } from "./doctor.ts";
import { parseInterval, schedule } from "./schedule.ts";
import { type SeedOptions, seed } from "./seed.ts";
import { uninstall } from "./uninstall.ts";
import { verify } from "./verify.ts";
import { defaultDeps, type SetupDeps, wire } from "./wire.ts";

/** The setup area bound to a dependency factory; tests pass one that never reaches the real machine. */
export function createSetupArea(depsFor: (ctx: LearnContext) => SetupDeps = defaultDeps): LearnArea {
  return {
    summary: "install and check the host wiring: hooks, scheduler, claude-mem mode, first seed",
    verbs: {
      doctor: {
        usage: "setup doctor [--live-judge]                   report prerequisites; live probe only when asked",
        run: (args, ctx) => doctor(ctx, depsFor(ctx), { liveJudge: args.flags.has("live-judge") }),
      },
      wire: {
        usage:
          "setup wire [--host claude|codex] [--no-mem] [--restart-worker]  merge hook entries and claude-mem settings",
        run: (args, ctx) => {
          const host = flag(args, "host");
          if (host !== undefined && host !== "claude" && host !== "codex") {
            ctx.io.err("ak learn setup wire: --host is claude or codex");
            return 2;
          }
          return wire(ctx, depsFor(ctx), {
            host,
            noMem: args.flags.has("no-mem"),
            restartWorker: args.flags.has("restart-worker"),
          });
        },
      },
      schedule: {
        usage: "setup schedule [--interval 15m] [--load]      write the scheduler unit for `ak learn memory tick`",
        run: (args, ctx) => {
          const intervalS = parseInterval(flag(args, "interval"));
          if (intervalS === null) {
            ctx.io.err("ak learn setup schedule: --interval is seconds, or Nm / Nh, and at least a minute");
            return 2;
          }
          return schedule(ctx, depsFor(ctx), { intervalS, load: args.flags.has("load") });
        },
      },
      seed: {
        usage:
          "setup seed --repo P [--since YYYY-MM-DD]      register a repo, create its ledgers, dry-run the first ingest",
        run: (args, ctx) => {
          const repo = flag(args, "repo");
          if (repo === undefined) {
            ctx.io.err("ak learn setup seed: --repo is required");
            return 2;
          }
          const since = flag(args, "since");
          const options: SeedOptions = {};
          if (since !== undefined) options.since = since;
          options.skipGithub = args.flags.has("no-github");
          return seed(ctx, repo, options);
        },
      },
      verify: {
        usage: "setup verify [--repo P]                       check wiring, scheduler unit, ledgers and judge",
        run: (args, ctx) => verify(ctx, depsFor(ctx), flag(args, "repo")),
      },
      uninstall: {
        usage: "setup uninstall [--purge]                     remove hooks and the unit; ledgers kept unless --purge",
        run: (args, ctx) => uninstall(ctx, depsFor(ctx), { purge: args.flags.has("purge") }),
      },
    },
  };
}

export const setupArea: LearnArea = createSetupArea();
