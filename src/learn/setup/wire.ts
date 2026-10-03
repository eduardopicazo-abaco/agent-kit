/**
 * `ak learn setup wire` — merge this runtime's hook entries into the host
 * configuration, and point claude-mem at the review-learning mode.
 *
 * Every write is an idempotent merge: an entry of ours is recognised by the
 * `learn hook` marker in its command, updated in place when the command line
 * changed, and never duplicated. Foreign entries are left exactly as found,
 * and every file is copied to `<file>.bak` before it is rewritten.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { run, type RunResult } from "../core/proc.ts";
import { PACKAGE_ROOT } from "../core/roles.ts";
import { writeJson } from "../core/store.ts";

/** Everything setup touches outside the config dir, injectable so tests never reach the real machine. */
export interface SetupDeps {
  home: string;
  platform: NodeJS.Platform;
  uid: number;
  run: (cmd: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => RunResult;
  which: (bin: string) => string | null;
  /** The argv prefix that runs `ak`: bun, then `<package root>/src/cli.ts`. */
  ak: string[];
  packageRoot: string;
}

export function defaultDeps(ctx: LearnContext): SetupDeps {
  const which = (bin: string) => Bun.which(bin, { PATH: ctx.env.PATH ?? "" });
  return {
    home: ctx.env.HOME && ctx.env.HOME !== "" ? ctx.env.HOME : homedir(),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    run: (cmd, options) => run(cmd, { timeoutMs: 60_000, env: options?.env ?? ctx.env }),
    which,
    ak: [which("bun") ?? "bun", join(PACKAGE_ROOT, "src", "cli.ts")],
    packageRoot: PACKAGE_ROOT,
  };
}

/** Single-quote an argument for a POSIX shell when it needs it. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

export interface HookCommands {
  sessionStart: string;
  claudeStop: string;
  codexStop: string;
  codexPrompt: string;
}

export function hookCommands(deps: SetupDeps): HookCommands {
  const base = `${deps.ak.map(shellQuote).join(" ")} learn hook`;
  return {
    sessionStart: `${base} session-start`,
    claudeStop: `${base} stop`,
    codexStop: `${base} stop --source codex`,
    codexPrompt: `${base} prompt`,
  };
}

const OUR_HOOK = /(?:^|[\s/"'])(?:ak|cli\.ts)['"]?\s+learn\s+hook\s+(.*)$/;

/** The `learn hook` arguments of a command of ours (`stop --source codex`), or null for a foreign command. */
export function ourHookVerb(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const match = OUR_HOOK.exec(command.trim());
  return match === null ? null : match[1]!.trim().replace(/\s+/g, " ");
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: unknown; timeout?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface HookDoc {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

/**
 * Add one hook entry unless it is already there. An entry of ours for the same
 * verb whose command line differs (the package moved) is updated in place.
 * Returns true when the document changed.
 */
export function ensureHook(
  doc: HookDoc,
  event: string,
  command: string,
  options: { matcher?: string; timeout?: number } = {},
): boolean {
  const timeout = options.timeout ?? 10;
  doc.hooks ??= {};
  const entries = (doc.hooks[event] ??= []);
  const hooks = entries.flatMap((entry) => entry.hooks ?? []);
  if (hooks.some((hook) => hook.command === command)) return false;
  const verb = ourHookVerb(command);
  const ours = hooks.filter((hook) => verb !== null && ourHookVerb(hook.command) === verb);
  const stale = ours[0];
  if (stale !== undefined) {
    stale.command = command;
    stale.timeout = timeout;
    return true;
  }
  const entry: HookEntry = { hooks: [{ type: "command", command, timeout }] };
  if (options.matcher !== undefined) entry.matcher = options.matcher;
  entries.push(entry);
  return true;
}

/** Remove every hook of ours. An entry left with no hooks goes, and so does an event left with no entries. Returns entries touched. */
export function dropHooks(doc: HookDoc): number {
  let touched = 0;
  const emptied = new Set<string>();
  for (const [event, entries] of Object.entries(doc.hooks ?? {})) {
    const keep: HookEntry[] = [];
    for (const entry of entries) {
      const hooks = entry.hooks ?? [];
      const foreign = hooks.filter((hook) => ourHookVerb(hook.command) === null);
      if (foreign.length !== hooks.length) touched += 1;
      if (foreign.length === 0 && hooks.length > 0) continue;
      entry.hooks = foreign;
      keep.push(entry);
    }
    if (keep.length === 0) emptied.add(event);
    else doc.hooks![event] = keep;
  }
  if (emptied.size > 0) {
    doc.hooks = Object.fromEntries(Object.entries(doc.hooks ?? {}).filter(([event]) => !emptied.has(event)));
  }
  return touched;
}

/** Count hooks of ours for one verb under one event. */
export function countHook(doc: HookDoc, event: string, verb: string): number {
  return (doc.hooks?.[event] ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .filter((hook) => ourHookVerb(hook.command) === verb).length;
}

/**
 * A JSON object file, strictly: `{}` when the file is absent, null when it
 * exists but is not a JSON object. A lenient read would turn a hand-edit typo
 * into an empty document and the next write would erase the user's settings.
 */
export function readJsonObject<T extends object>(path: string, empty: T): T | null {
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function invalidJsonMessage(path: string): string {
  return `${path} is not valid JSON; fix it or remove it, nothing written`;
}

/**
 * Write JSON, first copying the previous file to `<path>.bak` when no backup
 * exists yet. The first backup is the user's own file; a later write never
 * replaces it with a copy of ours.
 */
export function writeJsonWithBackup(path: string, doc: unknown): void {
  if (existsSync(path) && !existsSync(`${path}.bak`)) copyFileSync(path, `${path}.bak`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

export function claudeSettingsPath(ctx: LearnContext): string {
  return join(ctx.config.configDir, "settings.json");
}

export function codexHome(ctx: LearnContext, deps: SetupDeps): string {
  const override = ctx.env.CODEX_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(deps.home, ".codex");
}

export function memDir(ctx: LearnContext, deps: SetupDeps): string {
  const override = ctx.env.CLAUDE_MEM_DATA_DIR;
  return override !== undefined && override.trim() !== "" ? override : join(deps.home, ".claude-mem");
}

export const MEM_MODE = "code--review-learning";
/** claude-mem's context budget: its default is 50 observations, which crowds out the merged block. */
export const CONTEXT_OBSERVATIONS = "25";
export const SESSION_MATCHER = "startup|resume|clear|compact";

export function modeSource(deps: SetupDeps): string {
  return join(deps.packageRoot, "adapters", "observation-source", "claude-mem", `${MEM_MODE}.json`);
}

/** The newest claude-mem `worker-service.cjs` under a plugin cache. */
export function memWorkerScript(ctx: LearnContext, deps: SetupDeps): string | null {
  const found: string[] = [];
  for (const base of new Set([ctx.config.configDir, join(deps.home, ".claude")])) {
    const cache = join(base, "plugins", "cache");
    for (const market of safeList(cache)) {
      for (const version of safeList(join(cache, market, "claude-mem"))) {
        const script = join(cache, market, "claude-mem", version, "scripts", "worker-service.cjs");
        if (existsSync(script)) found.push(script);
      }
    }
  }
  return found.sort().at(-1) ?? null;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface WireOptions {
  /** One host only; both by default, Codex only when its home exists. */
  host?: "claude" | "codex";
  /** Skip claude-mem's settings and mode file. */
  noMem?: boolean;
  /** Restart claude-mem's worker after a settings change. Off unless asked for. */
  restartWorker?: boolean;
}

function wireClaude(ctx: LearnContext, commands: HookCommands): void {
  const path = claudeSettingsPath(ctx);
  const doc = readJsonObject<HookDoc>(path, {}) ?? {};
  let changed = 0;
  if (ensureHook(doc, "SessionStart", commands.sessionStart, { matcher: SESSION_MATCHER })) changed += 1;
  if (ensureHook(doc, "Stop", commands.claudeStop, { timeout: 120 })) changed += 1;
  if (changed > 0) writeJsonWithBackup(path, doc);
  ctx.io.out(changed > 0 ? `${path}: ${changed} hook entries added or updated` : `${path}: already wired`);
}

function wireCodex(ctx: LearnContext, deps: SetupDeps, commands: HookCommands, explicit: boolean): void {
  const home = codexHome(ctx, deps);
  if (!existsSync(home) && !explicit) {
    ctx.io.out(`${home} not present; skipping Codex hooks (pass --host codex to create it)`);
    return;
  }
  const path = join(home, "hooks.json");
  const doc = readJsonObject<HookDoc>(path, {}) ?? {};
  let changed = 0;
  if (ensureHook(doc, "SessionStart", commands.sessionStart)) changed += 1;
  if (ensureHook(doc, "UserPromptSubmit", commands.codexPrompt)) changed += 1;
  if (ensureHook(doc, "Stop", commands.codexStop, { timeout: 30 })) changed += 1;
  if (changed > 0) writeJsonWithBackup(path, doc);
  ctx.io.out(changed > 0 ? `${path}: ${changed} hook entries added or updated` : `${path}: already wired`);
}

/** Install the mode file and set the observation budget. Returns true when claude-mem's settings changed. */
export function wireMem(ctx: LearnContext, deps: SetupDeps): boolean {
  const dir = memDir(ctx, deps);
  const source = modeSource(deps);
  const target = join(dir, "modes", `${MEM_MODE}.json`);
  let modeReady = existsSync(target);
  if (!existsSync(source)) {
    ctx.io.out(`mode file not shipped at ${source}; claude-mem keeps its current mode`);
  } else {
    const text = readFileSync(source, "utf8");
    if (!existsSync(target) || readFileSync(target, "utf8") !== text) {
      if (existsSync(target) && !existsSync(`${target}.bak`)) copyFileSync(target, `${target}.bak`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      ctx.io.out(`${target}: mode installed`);
    }
    modeReady = true;
  }
  const settingsPath = join(dir, "settings.json");
  const doc = readJsonObject<Record<string, unknown>>(settingsPath, {}) ?? {};
  const before = JSON.stringify(doc);
  const previous = memPreviousPath(ctx);
  if (!existsSync(previous)) {
    writeJson(previous, {
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: doc.CLAUDE_MEM_CONTEXT_OBSERVATIONS ?? null,
      CLAUDE_MEM_MODE: doc.CLAUDE_MEM_MODE ?? null,
    });
  }
  doc.CLAUDE_MEM_CONTEXT_OBSERVATIONS = CONTEXT_OBSERVATIONS;
  if (modeReady && doc.CLAUDE_MEM_MODE === undefined) doc.CLAUDE_MEM_MODE = MEM_MODE;
  if (JSON.stringify(doc) === before) {
    ctx.io.out(`${settingsPath}: already set`);
    return false;
  }
  writeJsonWithBackup(settingsPath, doc);
  ctx.io.out(
    `${settingsPath}: CLAUDE_MEM_CONTEXT_OBSERVATIONS=${CONTEXT_OBSERVATIONS}, mode=${String(doc.CLAUDE_MEM_MODE ?? "unchanged")}`,
  );
  return true;
}

/** claude-mem's settings as they were before the first wire, so uninstall restores them rather than deleting them. */
export function memPreviousPath(ctx: LearnContext): string {
  return join(ctx.config.runtimeDir, "claude-mem-previous.json");
}

export function restartWorker(ctx: LearnContext, deps: SetupDeps): void {
  const script = memWorkerScript(ctx, deps);
  const runner = deps.which("bun") ?? deps.which("node");
  if (script === null || runner === null) {
    ctx.io.out("restart the claude-mem worker by hand so the new settings take effect");
    return;
  }
  const result = deps.run([runner, script, "restart"]);
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  ctx.io.out(
    `claude-mem worker: ${result.code === 0 && last !== "" ? last : `restart failed; run it by hand: ${runner} ${script} restart`}`,
  );
}

export function wire(ctx: LearnContext, deps: SetupDeps, options: WireOptions = {}): number {
  const commands = hookCommands(deps);
  const claude = options.host !== "codex";
  const codex = options.host !== "claude" && (options.host === "codex" || existsSync(codexHome(ctx, deps)));
  const mem = options.noMem !== true && options.host !== "codex";
  // Every file is checked before any is written, so a refusal leaves the whole setup as it was.
  const targets = [
    ...(claude ? [claudeSettingsPath(ctx)] : []),
    ...(codex ? [join(codexHome(ctx, deps), "hooks.json")] : []),
    ...(mem ? [join(memDir(ctx, deps), "settings.json")] : []),
  ];
  const invalid = targets.filter((path) => readJsonObject(path, {}) === null);
  if (invalid.length > 0) {
    for (const path of invalid) ctx.io.err(invalidJsonMessage(path));
    return 1;
  }
  if (claude) wireClaude(ctx, commands);
  if (options.host !== "claude") wireCodex(ctx, deps, commands, options.host === "codex");
  if (mem) {
    const changed = wireMem(ctx, deps);
    if (changed && options.restartWorker === true) restartWorker(ctx, deps);
    else if (changed)
      ctx.io.out("restart the claude-mem worker for the new settings to apply (or rerun with --restart-worker)");
  }
  return 0;
}
