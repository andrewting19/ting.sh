import { spawnPty as spawnPtyUnix } from "./pty-unix";

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

export function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "zsh";
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
