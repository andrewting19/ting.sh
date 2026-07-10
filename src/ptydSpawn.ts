import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Spawning ptyd detached from the caller's process tree is platform-sensitive
// on macOS: a nohup/detached child permanently inherits the spawning terminal
// app (e.g. Ghostty) as its TCC "responsible process", and when that app's
// file-access grant goes stale (typically after the app auto-updates) the
// daemon silently loses ~/Documents access. Bootstrapping through launchd
// instead makes ptyd its own TCC identity, so a one-time grant to `bun`
// survives terminal-app updates.

export interface PtydSpawnConfig {
  /** Repo root containing ptyd.ts — becomes the daemon's working directory. */
  cwd: string;
  ptydPort: number;
  logPath: string;
  /** Exact env overrides for the daemon (TING_PORT, PTYD_PORT, ...). */
  env: Record<string, string>;
}

export function ptydLogDir(): string {
  return join(tmpdir(), "ting-sh");
}

export function ptydLogPath(ptydPort: number): string {
  return join(ptydLogDir(), `ptyd-${ptydPort}.log`);
}

export function ptydLaunchdLabel(ptydPort: number): string {
  return `sh.ting.ptyd.${ptydPort}`;
}

export function shouldUseLaunchd(): boolean {
  if (process.platform !== "darwin") return false;
  // Tests own their ptyd lifecycle as plain child processes; never register
  // launchd jobs from a test run. PTYD_LAUNCHD=0 is a manual escape hatch.
  if (process.env.TING_TEST_MODE === "1") return false;
  if (process.env.PTYD_LAUNCHD === "0") return false;
  return true;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildLaunchdPlist(config: PtydSpawnConfig): string {
  const env: Record<string, string> = { ...config.env };
  // launchd agents get a minimal environment; ptyd needs the user's PATH for
  // the shells it spawns and helpers like lsof, and SHELL to pick the right
  // default shell for new sessions.
  for (const key of ["PATH", "HOME", "SHELL"]) {
    const value = process.env[key];
    if (value && !(key in env)) env[key] = value;
  }
  const envEntries = Object.entries(env)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xmlEscape(ptydLaunchdLabel(config.ptydPort))}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(process.execPath)}</string>
      <string>run</string>
      <string>${xmlEscape(join(config.cwd, "ptyd.ts"))}</string>
    </array>
    <key>WorkingDirectory</key><string>${xmlEscape(config.cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>StandardOutPath</key><string>${xmlEscape(config.logPath)}</string>
    <key>StandardErrorPath</key><string>${xmlEscape(config.logPath)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
  </dict>
</plist>
`;
}

async function runLaunchctl(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

async function spawnViaLaunchd(config: PtydSpawnConfig): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("cannot resolve uid for launchd gui domain");
  const label = ptydLaunchdLabel(config.ptydPort);
  const plistPath = join(ptydLogDir(), `${label}.plist`);
  mkdirSync(ptydLogDir(), { recursive: true });
  writeFileSync(plistPath, buildLaunchdPlist(config));
  // A stale registration from a previous (possibly dead) daemon blocks
  // bootstrap; bootout is a no-op error when the label isn't loaded.
  await runLaunchctl(["bootout", `gui/${uid}/${label}`]);
  const bootstrap = await runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
  if (bootstrap.code !== 0) {
    throw new Error(`launchctl bootstrap failed (exit ${bootstrap.code}): ${bootstrap.stderr.trim()}`);
  }
  return `launchd agent ${label}`;
}

function spawnViaDetachedChild(config: PtydSpawnConfig): string {
  Bun.spawn([process.execPath, "run", "ptyd.ts"], {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  return "detached child process";
}

export async function spawnPtydDetached(config: PtydSpawnConfig): Promise<string> {
  if (shouldUseLaunchd()) return await spawnViaLaunchd(config);
  return spawnViaDetachedChild(config);
}
