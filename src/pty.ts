import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnPty as spawnPtyUnix } from "./pty-unix";
import {
  applyWindowsSessionIdentity,
  buildGitBashPromptCommand,
  isGitBashShell,
  isWindowsServiceProfileHome,
  normalizeWindowsPath,
  resolveWindowsSessionIdentityFromEnv,
  type WindowsSessionIdentity,
} from "./windowsShellIntegration";

export interface PtyProcess {
  readonly pid: number;
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  onData: (data: Uint8Array) => void;
  onExit: () => void;
}

function readWindowsRegistryDefaultShell(): string | null {
  if (process.platform !== "win32") return null;

  try {
    const shell = readWindowsRegistryValue("HKLM\\SOFTWARE\\OpenSSH", "DefaultShell");
    if (!shell) return null;
    const normalized = normalizeWindowsPath(shell);
    return existsSync(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function readWindowsRegistryValue(key: string, valueName: string): string | null {
  if (process.platform !== "win32") return null;

  try {
    const result = Bun.spawnSync(["reg.exe", "query", key, "/v", valueName], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0 || !result.stdout) return null;
    const text = Buffer.from(result.stdout).toString("utf8");
    const match = text.match(new RegExp(`${valueName}\\s+REG_\\w+\\s+(.+)$`, "m"));
    if (!match) return null;
    return match[1].trim();
  } catch {
    return null;
  }
}

function expandWindowsEnvVariables(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, variable: string) => process.env[variable] ?? `%${variable}%`);
}

function readWindowsRegistryDefaultUser(): string | null {
  const user = readWindowsRegistryValue(
    "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon",
    "DefaultUserName",
  );
  return user?.trim() || null;
}

function findWindowsProfileHome(user: string): string | null {
  if (process.platform !== "win32") return null;

  const leafUser = user.includes("\\") ? user.split("\\").at(-1) ?? user : user;
  try {
    const result = Bun.spawnSync(
      ["reg.exe", "query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList", "/s", "/v", "ProfileImagePath"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (result.exitCode === 0 && result.stdout) {
      const text = Buffer.from(result.stdout).toString("utf8");
      for (const match of text.matchAll(/ProfileImagePath\s+REG_\w+\s+(.+)$/gm)) {
        const expanded = normalizeWindowsPath(expandWindowsEnvVariables(match[1].trim()));
        if (!expanded) continue;
        if (basename(expanded).toLowerCase() !== leafUser.toLowerCase()) continue;
        if (existsSync(expanded)) return expanded;
      }
    }
  } catch {
    // fall through to the conventional profile path guess
  }

  const defaultProfile = normalizeWindowsPath(`${process.env.SystemDrive ?? "C:"}/Users/${leafUser}`);
  return existsSync(defaultProfile) ? defaultProfile : null;
}

let cachedWindowsSessionIdentity: WindowsSessionIdentity | null = null;

function needsWindowsSessionFallback(identity: WindowsSessionIdentity): boolean {
  return !identity.home || isWindowsServiceProfileHome(identity.home);
}

function getWindowsSessionIdentity(): WindowsSessionIdentity {
  if (process.platform !== "win32") return {};
  if (cachedWindowsSessionIdentity) return cachedWindowsSessionIdentity;

  const identity = resolveWindowsSessionIdentityFromEnv(process.env);
  if (needsWindowsSessionFallback(identity)) {
    const registryUser = readWindowsRegistryDefaultUser() ?? undefined;
    const registryHome = registryUser ? findWindowsProfileHome(registryUser) ?? undefined : undefined;

    if ((!identity.home || isWindowsServiceProfileHome(identity.home)) && registryHome) {
      identity.home = registryHome;
    }
  }

  cachedWindowsSessionIdentity = identity;
  return identity;
}

function applyWindowsSessionEnv(env: Record<string, string>): Record<string, string> {
  if (process.platform !== "win32") return env;
  return applyWindowsSessionIdentity(env, getWindowsSessionIdentity());
}

function defaultWindowsCwd(): string | undefined {
  const identity = getWindowsSessionIdentity();
  if (identity.home) return normalizeWindowsPath(identity.home);

  const home = process.env.HOME
    || process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : undefined);
  return home ? normalizeWindowsPath(home) : undefined;
}

function prepareWindowsShellEnv(shell: string, env: Record<string, string>): Record<string, string> {
  const withIdentity = applyWindowsSessionEnv(env);
  if (!isGitBashShell(shell)) return withIdentity;

  return {
    ...withIdentity,
    CHERE_INVOKING: withIdentity.CHERE_INVOKING || "1",
    PROMPT_COMMAND: buildGitBashPromptCommand(withIdentity.PROMPT_COMMAND),
  };
}

function findGitBash(): string | null {
  const candidates = [
    process.env.SHELL ? normalizeWindowsPath(process.env.SHELL) : "",
    readWindowsRegistryDefaultShell() ?? "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "usr", "bin", "bash.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "bash.exe") : "",
    process.env.LocalAppData ? join(process.env.LocalAppData, "Programs", "Git", "bin", "bash.exe") : "",
    process.env.LocalAppData ? join(process.env.LocalAppData, "Programs", "Git", "usr", "bin", "bash.exe") : "",
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeWindowsPath(candidate);
    if (normalized && existsSync(normalized)) return normalized;
  }

  return null;
}

export function defaultShell(): string {
  if (process.platform === "win32") {
    return findGitBash() || process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "zsh";
}

export function defaultCwd(): string | undefined {
  if (process.platform === "win32") {
    return defaultWindowsCwd();
  }

  return process.env.HOME || undefined;
}

export function prepareEnvForShell(shell: string, env: Record<string, string>): Record<string, string> {
  if (process.platform !== "win32") return env;
  return prepareWindowsShellEnv(shell, env);
}

type SpawnPtyFn = (options: PtySpawnOptions) => PtyProcess;
let spawnPtyWin: SpawnPtyFn | null = null;

if (process.platform === "win32") {
  try {
    const mod = require("./pty-windows") as { spawnPty: SpawnPtyFn };
    spawnPtyWin = mod.spawnPty;
  } catch {
    // node-pty is optional and may be unavailable depending on platform/build.
  }
}

export function spawnPty(options: PtySpawnOptions): PtyProcess {
  if (process.platform === "win32" && spawnPtyWin) {
    return spawnPtyWin(options);
  }
  return spawnPtyUnix(options);
}
