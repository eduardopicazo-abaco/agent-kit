/**
 * `ak learn setup schedule` — the scheduler unit that runs `ak learn memory tick`.
 *
 * launchd on macOS, a systemd user timer where `systemctl` exists, otherwise a
 * cron line to add by hand. `PATH` and a non-default `CLAUDE_CONFIG_DIR` are
 * baked into the unit because a scheduler starts with neither. The default
 * config path stays implicit so the judge uses the operator's normal login.
 * The unit carries no
 * sandboxing directive such as `ProtectHome`: the tick must read claude-mem's
 * database under the home directory.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LearnContext } from "../core/context.ts";
import type { SetupDeps } from "./wire.ts";
import { shellQuote } from "./wire.ts";

export const LABEL = "dev.agent-kit.learn";
export const DEFAULT_INTERVAL_S = 900;
const TEMPLATES = join(import.meta.dir, "templates");

export type SchedulerKind = "launchd" | "systemd" | "cron" | "none";

export function schedulerKind(deps: SetupDeps): SchedulerKind {
  if (deps.platform === "darwin") return "launchd";
  if (deps.which("systemctl") !== null) return "systemd";
  return deps.which("crontab") !== null ? "cron" : "none";
}

export interface UnitPaths {
  unit: string;
  timer?: string;
}

export function unitPaths(deps: SetupDeps, kind: SchedulerKind): UnitPaths | null {
  if (kind === "launchd") return { unit: join(deps.home, "Library", "LaunchAgents", `${LABEL}.plist`) };
  if (kind === "systemd") {
    const dir = join(deps.home, ".config", "systemd", "user");
    return { unit: join(dir, `${LABEL}.service`), timer: join(dir, `${LABEL}.timer`) };
  }
  return null;
}

export function tickArgv(deps: SetupDeps): string[] {
  return [...deps.ak, "learn", "memory", "tick"];
}

export function schedulerLog(ctx: LearnContext): string {
  return join(ctx.config.runtimeDir, "scheduler.log");
}

/** Variables passed through to the unit when set: where claude-mem lives, and every `AK_LEARN_*` knob including the judge command. */
const PASSTHROUGH = ["CLAUDE_MEM_DATA_DIR", "CODEX_HOME"];

/** The unit's environment, in a stable order. */
export function unitEnvironment(ctx: LearnContext, deps: SetupDeps): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (resolve(ctx.config.configDir) !== resolve(deps.home, ".claude")) {
    out.push(["CLAUDE_CONFIG_DIR", ctx.config.configDir]);
  }
  out.push(["PATH", ctx.env.PATH && ctx.env.PATH !== "" ? ctx.env.PATH : "/usr/local/bin:/usr/bin:/bin"]);
  const extra = Object.keys(ctx.env)
    .filter((key) => PASSTHROUGH.includes(key) || key.startsWith("AK_LEARN_"))
    .sort();
  for (const key of extra) {
    const value = ctx.env[key];
    if (value !== undefined && value !== "") out.push([key, value]);
  }
  return out;
}

/** `$name` / `${name}` substitution. A variable with no value is an error, never an empty string. */
export function renderTemplate(name: string, vars: Readonly<Record<string, string | number>>): string {
  const text = readFileSync(join(TEMPLATES, name), "utf8");
  return text.replace(/\$(?:\{(\w+)\}|(\w+))/g, (_, braced: string | undefined, bare: string | undefined) => {
    const key = (braced ?? bare)!;
    const value = vars[key];
    if (value === undefined) throw new Error(`template ${name}: no value for $${key}`);
    return String(value);
  });
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(ctx: LearnContext, deps: SetupDeps, intervalS: number): string {
  return renderTemplate("launchd.plist.tmpl", {
    label: LABEL,
    arguments: tickArgv(deps)
      .map((arg) => `    <string>${xml(arg)}</string>`)
      .join("\n"),
    interval: intervalS,
    environment: unitEnvironment(ctx, deps)
      .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
      .join("\n"),
    log: xml(schedulerLog(ctx)),
  });
}

/** systemd expands `%` specifiers and `$` variables in these lines; both are doubled so a value reaches the tick verbatim. */
function systemdQuote(arg: string): string {
  const escaped = arg.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdService(ctx: LearnContext, deps: SetupDeps): string {
  return renderTemplate("systemd.service.tmpl", {
    exec: tickArgv(deps).map(systemdQuote).join(" "),
    environment: unitEnvironment(ctx, deps)
      .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
      .join("\n"),
    log: systemdQuote(schedulerLog(ctx)),
  });
}

export function systemdTimer(intervalS: number): string {
  return renderTemplate("systemd.timer.tmpl", {
    minutes: Math.max(1, Math.round(intervalS / 60)),
    unit: `${LABEL}.service`,
  });
}

/** A crontab line. Intervals of an hour or more fire on the hour. Cron turns a bare `%` into a newline, so each is escaped. */
export function cronLine(ctx: LearnContext, deps: SetupDeps, intervalS: number): string {
  const minutes = Math.max(1, Math.round(intervalS / 60));
  const when =
    minutes < 60 ? `*/${minutes} * * * *` : `0 */${Math.max(1, Math.min(23, Math.round(minutes / 60)))} * * *`;
  const env = unitEnvironment(ctx, deps).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = `${[...env, ...tickArgv(deps).map(shellQuote)].join(" ")} >> ${shellQuote(schedulerLog(ctx))} 2>&1`;
  return `${when} ${command.replace(/%/g, "\\%")}`;
}

/** `900`, `15m` or `1h` as seconds; null when unparseable or under a minute. */
export function parseInterval(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_INTERVAL_S;
  const match = /^(\d+)([smh]?)$/.exec(value.trim());
  if (match === null) return null;
  const n = Number.parseInt(match[1]!, 10) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
  return n >= 60 ? n : null;
}

/** Units carry `AK_LEARN_*` values such as the judge command, so they are readable by their owner only. */
function writeIfChanged(ctx: LearnContext, path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) {
    chmodSync(path, 0o600);
    ctx.io.out(`${path}: unchanged`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  ctx.io.out(`${path}: written`);
}

/** Write the unit for this machine's scheduler, and load it when asked. */
export function schedule(
  ctx: LearnContext,
  deps: SetupDeps,
  options: { intervalS?: number; load?: boolean } = {},
): number {
  const intervalS = options.intervalS ?? DEFAULT_INTERVAL_S;
  const kind = schedulerKind(deps);
  mkdirSync(ctx.config.runtimeDir, { recursive: true });
  if (kind === "none") {
    ctx.io.out("no supported scheduler (launchd, systemd, cron); run this from your own scheduler:");
    ctx.io.out(`  ${tickArgv(deps).map(shellQuote).join(" ")}`);
    return 0;
  }
  if (kind === "cron") {
    ctx.io.out("add this line with `crontab -e`:");
    ctx.io.out(`  ${cronLine(ctx, deps, intervalS)}`);
    return 0;
  }
  const paths = unitPaths(deps, kind)!;
  if (kind === "launchd") {
    writeIfChanged(ctx, paths.unit, launchdPlist(ctx, deps, intervalS));
  } else {
    writeIfChanged(ctx, paths.unit, systemdService(ctx, deps));
    writeIfChanged(ctx, paths.timer!, systemdTimer(intervalS));
  }
  if (options.load !== true) {
    ctx.io.out("not loaded; rerun with --load to register it");
    return 0;
  }
  return loadUnit(ctx, deps, kind, paths);
}

export function loadUnit(ctx: LearnContext, deps: SetupDeps, kind: SchedulerKind, paths: UnitPaths): number {
  if (kind === "launchd") {
    const domain = `gui/${deps.uid}`;
    deps.run(["launchctl", "bootout", `${domain}/${LABEL}`]);
    const result = deps.run(["launchctl", "bootstrap", domain, paths.unit]);
    ctx.io.out(`launchd: ${result.code === 0 ? "loaded" : `bootstrap failed: ${result.stderr.trim()}`}`);
    ctx.io.out(`status:  launchctl print ${domain}/${LABEL}`);
    return result.code === 0 ? 0 : 1;
  }
  if (kind === "systemd") {
    deps.run(["systemctl", "--user", "daemon-reload"]);
    const result = deps.run(["systemctl", "--user", "enable", "--now", `${LABEL}.timer`]);
    ctx.io.out(`systemd: ${result.code === 0 ? "timer enabled" : `enable failed: ${result.stderr.trim()}`}`);
    ctx.io.out(`status:  systemctl --user list-timers ${LABEL}.timer`);
    return result.code === 0 ? 0 : 1;
  }
  return 0;
}
