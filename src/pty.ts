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
  return process.env.SHELL || "zsh";
}

export function spawnPty(options: PtySpawnOptions): PtyProcess {
  // Phase 2: add win32 branch → "./pty-windows"
  return spawnPtyUnix(options);
}
