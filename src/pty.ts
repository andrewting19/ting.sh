import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnPty as spawnPtyUnix } from "./pty-unix";
import { buildGitBashPromptCommand, isGitBashShell, normalizeWindowsPath } from "./windowsShellIntegration";

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
    const result = Bun.spawnSync(["reg.exe", "query", "HKLM\\SOFTWARE\\OpenSSH", "/v", "DefaultShell"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0 || !result.stdout) return null;
    const text = Buffer.from(result.stdout).toString("utf8");
    const match = text.match(/DefaultShell\s+REG_\w+\s+(.+)$/m);
    if (!match) return null;
    const shell = normalizeWindowsPath(match[1]);
    return existsSync(shell) ? shell : null;
  } catch {
    return null;
  }
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
    const home = process.env.HOME
      || process.env.USERPROFILE
      || (process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : undefined);
    return home ? normalizeWindowsPath(home) : undefined;
  }

  return process.env.HOME || undefined;
}

export function prepareEnvForShell(shell: string, env: Record<string, string>): Record<string, string> {
  if (process.platform !== "win32" || !isGitBashShell(shell)) return env;

  return {
    ...env,
    CHERE_INVOKING: env.CHERE_INVOKING || "1",
    PROMPT_COMMAND: buildGitBashPromptCommand(env.PROMPT_COMMAND),
  };
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
