import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/learn/core/config.ts";
import type { LearnContext } from "../../src/learn/core/context.ts";
import { projectFolderName } from "../../src/learn/core/paths.ts";
import type { RunResult } from "../../src/learn/core/proc.ts";
import {
  cronLine,
  launchdPlist,
  parseInterval,
  schedule,
  systemdService,
  systemdTimer,
  unitEnvironment,
  unitPaths,
} from "../../src/learn/setup/schedule.ts";
import type { SetupDeps } from "../../src/learn/setup/wire.ts";
import { scratch } from "./helpers.ts";

/** A context whose environment is exactly `env`, so nothing from the developer's shell leaks into a golden. */
function context(env: Record<string, string>, out: string[] = []): LearnContext {
  return {
    cwd: "/",
    io: { out: (line) => out.push(line), err: (line) => out.push(line) },
    config: loadConfig(env),
    judge: () => null,
    env,
  };
}

function deps(
  options: { platform?: NodeJS.Platform; bins?: string[]; home?: string; code?: number } = {},
): SetupDeps & { calls: string[][] } {
  const bins = new Set(options.bins ?? []);
  const calls: string[][] = [];
  return {
    home: options.home ?? "/home/bob",
    platform: options.platform ?? "linux",
    uid: 501,
    run: (cmd): RunResult => {
      calls.push([...cmd]);
      return { code: options.code ?? 0, stdout: "", stderr: "denied", timedOut: false };
    },
    which: (bin) => (bins.has(bin) ? `/usr/bin/${bin}` : null),
    ak: ["/opt/bun", "/pkg/src/cli.ts"],
    packageRoot: "/pkg",
    calls,
  };
}

const ENV = { CLAUDE_CONFIG_DIR: "/cfg", PATH: "/bin", AK_LEARN_JUDGE: "judge --json" };

describe("unit rendering goldens", () => {
  test("launchd plist", () => {
    const text = launchdPlist(context(ENV), deps(), 900);
    expect(text).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.agent-kit.learn</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/bun</string>
    <string>/pkg/src/cli.ts</string>
    <string>learn</string>
    <string>memory</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_CONFIG_DIR</key>
    <string>/cfg</string>
    <key>PATH</key>
    <string>/bin</string>
    <key>AK_LEARN_JUDGE</key>
    <string>judge --json</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/cfg/agent-kit/learn/scheduler.log</string>
  <key>StandardErrorPath</key>
  <string>/cfg/agent-kit/learn/scheduler.log</string>
</dict>
</plist>
`);
    expect(text).not.toContain("$");
  });

  test("systemd service, with no sandboxing that would hide claude-mem's database", () => {
    const text = systemdService(context(ENV), deps());
    expect(text).toBe(`[Unit]
Description=agent-kit learning runtime: scheduled memory tick

[Service]
Type=oneshot
ExecStart=/opt/bun /pkg/src/cli.ts learn memory tick
Environment=CLAUDE_CONFIG_DIR=/cfg
Environment=PATH=/bin
Environment="AK_LEARN_JUDGE=judge --json"
StandardOutput=append:/cfg/agent-kit/learn/scheduler.log
StandardError=append:/cfg/agent-kit/learn/scheduler.log
`);
    expect(text).not.toContain("ProtectHome");
    expect(text).not.toContain("$");
  });

  test("systemd timer interval", () => {
    const text = systemdTimer(900);
    expect(text).toContain("OnUnitActiveSec=15min\n");
    expect(text).toContain("Unit=dev.agent-kit.learn.service\n");
    expect(text).not.toContain("$");
  });

  test("cron line, minutes under an hour and hours above", () => {
    const tail =
      "CLAUDE_CONFIG_DIR=/cfg PATH=/bin AK_LEARN_JUDGE='judge --json' /opt/bun /pkg/src/cli.ts learn memory tick >> /cfg/agent-kit/learn/scheduler.log 2>&1";
    expect(cronLine(context(ENV), deps(), 900)).toBe(`*/15 * * * * ${tail}`);
    expect(cronLine(context(ENV), deps(), 7200)).toBe(`0 */2 * * * ${tail}`);
  });

  test("systemd specifiers and variables are escaped so values arrive verbatim", () => {
    const text = systemdService(
      context({ ...ENV, AK_LEARN_JUDGE: "judge --at 50% $HOME", AK_LEARN_TAG: "a%b" }),
      deps(),
    );
    expect(text).toContain('Environment="AK_LEARN_JUDGE=judge --at 50%% $$HOME"\n');
    expect(text).toContain('Environment="AK_LEARN_TAG=a%%b"\n');
  });

  test("cron percent signs are escaped", () => {
    const line = cronLine(context({ ...ENV, AK_LEARN_JUDGE: "judge --at 50%" }), deps(), 900);
    expect(line).toContain("AK_LEARN_JUDGE='judge --at 50\\%'");
    expect(line.replace(/\\%/g, "")).not.toContain("%");
  });

  test("XML-special values are escaped in the plist", () => {
    expect(launchdPlist(context({ ...ENV, AK_LEARN_JUDGE: "a<b & c" }), deps(), 900)).toContain(
      "<string>a&lt;b &amp; c</string>",
    );
  });
});

describe("paths", () => {
  test("the scheduler omits an explicit config dir when it is the host default", () => {
    const home = scratch("ak-home-");
    const ctx = context({ CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: "/bin" });
    expect(unitEnvironment(ctx, deps({ home }))).toEqual([["PATH", "/bin"]]);
    expect(launchdPlist(ctx, deps({ home }), 900)).not.toContain("CLAUDE_CONFIG_DIR");
  });

  test("the scheduler keeps a non-default config dir", () => {
    const home = scratch("ak-home-");
    const config = scratch("ak-cfg-");
    expect(unitEnvironment(context({ CLAUDE_CONFIG_DIR: config, PATH: "/bin" }), deps({ home }))).toContainEqual([
      "CLAUDE_CONFIG_DIR",
      config,
    ]);
  });

  test("the config dir follows the environment", () => {
    expect(loadConfig({ CLAUDE_CONFIG_DIR: "/somewhere/else" }).configDir).toBe("/somewhere/else");
    expect(loadConfig({}).configDir).toBe(join(homedir(), ".claude"));
  });

  test("the ledger folder matches the Claude Code convention", () => {
    expect(projectFolderName("/Users/bob/my_app")).toBe("-Users-bob-my-app");
  });

  test("unit paths per scheduler", () => {
    expect(unitPaths(deps(), "launchd")).toEqual({ unit: "/home/bob/Library/LaunchAgents/dev.agent-kit.learn.plist" });
    expect(unitPaths(deps(), "systemd")).toEqual({
      unit: "/home/bob/.config/systemd/user/dev.agent-kit.learn.service",
      timer: "/home/bob/.config/systemd/user/dev.agent-kit.learn.timer",
    });
    expect(unitPaths(deps(), "cron")).toBeNull();
  });

  test("interval parsing", () => {
    expect(parseInterval(undefined)).toBe(900);
    expect(parseInterval("600")).toBe(600);
    expect(parseInterval("15m")).toBe(900);
    expect(parseInterval("1h")).toBe(3600);
    expect(parseInterval("30s")).toBeNull();
    expect(parseInterval("soon")).toBeNull();
  });
});

describe("setup schedule", () => {
  test("launchd: writes the plist, loads only with --load, through the injected runner", () => {
    const home = scratch("ak-home-");
    const cfg = scratch("ak-cfg-");
    const d = deps({ platform: "darwin", home });
    const out: string[] = [];
    const ctx = context({ CLAUDE_CONFIG_DIR: cfg, PATH: "/bin" }, out);
    expect(schedule(ctx, d, { intervalS: 900 })).toBe(0);
    const plist = join(home, "Library", "LaunchAgents", "dev.agent-kit.learn.plist");
    expect(readFileSync(plist, "utf8")).toBe(launchdPlist(ctx, d, 900));
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    expect(d.calls).toEqual([]);
    expect(out.at(-1)).toBe("not loaded; rerun with --load to register it");

    expect(schedule(ctx, d, { intervalS: 900, load: true })).toBe(0);
    expect(out).toContain(`${plist}: unchanged`);
    expect(d.calls).toEqual([
      ["launchctl", "bootout", "gui/501/dev.agent-kit.learn"],
      ["launchctl", "bootstrap", "gui/501", plist],
    ]);
  });

  test("systemd: writes service and timer, enables the timer with --load, reports a failed enable", () => {
    const home = scratch("ak-home-");
    const d = deps({ bins: ["systemctl"], home, code: 1 });
    const ctx = context({ CLAUDE_CONFIG_DIR: scratch("ak-cfg-"), PATH: "/bin" });
    expect(schedule(ctx, d, { intervalS: 1800, load: true })).toBe(1);
    const dir = join(home, ".config", "systemd", "user");
    expect(readFileSync(join(dir, "dev.agent-kit.learn.timer"), "utf8")).toContain("OnUnitActiveSec=30min");
    expect(statSync(join(dir, "dev.agent-kit.learn.service")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "dev.agent-kit.learn.timer")).mode & 0o777).toBe(0o600);
    expect(d.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "dev.agent-kit.learn.timer"],
    ]);
  });

  test("cron: prints the line and writes no unit; no scheduler: prints the command", () => {
    const home = scratch("ak-home-");
    const out: string[] = [];
    const ctx = context({ CLAUDE_CONFIG_DIR: scratch("ak-cfg-"), PATH: "/bin" }, out);
    expect(schedule(ctx, deps({ bins: ["crontab"], home }), { load: true })).toBe(0);
    expect(out[1]).toStartWith("  */15 * * * * CLAUDE_CONFIG_DIR=");
    expect(existsSync(join(home, ".config"))).toBe(false);
    out.length = 0;
    expect(schedule(ctx, deps({ home }))).toBe(0);
    expect(out).toEqual([
      "no supported scheduler (launchd, systemd, cron); run this from your own scheduler:",
      "  /opt/bun /pkg/src/cli.ts learn memory tick",
    ]);
  });
});
