import { existsSync } from "fs";
import { defaultCwd, defaultShell, prepareEnvForShell, spawnPty } from "../pty";

export interface PtyTraceCapture {
  cols: number;
  rows: number;
  chunks: Uint8Array[];
  combined: Buffer;
}

export interface CapturePtyTraceOptions {
  script: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  startupDelayMs?: number;
  idleMs?: number;
  timeoutMs?: number;
}

function pickShell(explicit?: string): string {
  if (explicit) return explicit;
  if (process.platform !== "win32" && existsSync("/bin/bash")) return "/bin/bash";
  return defaultShell();
}

export async function capturePtyTrace(options: CapturePtyTraceOptions): Promise<PtyTraceCapture> {
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const shell = pickShell(options.shell);
  const startupDelayMs = options.startupDelayMs ?? 100;
  const idleMs = options.idleMs ?? 150;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const chunks: Uint8Array[] = [];

  const baseEnv = Object.fromEntries(
    Object.entries({ ...process.env, TERM: "xterm-256color" }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const env = prepareEnvForShell(shell, baseEnv);

  return await new Promise<PtyTraceCapture>((resolve, reject) => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      proc.kill();
      resolve({
        cols,
        rows,
        chunks,
        combined: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      });
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      proc.kill();
      reject(error);
    };

    const proc = spawnPty({
      shell,
      cwd: options.cwd || defaultCwd(),
      cols,
      rows,
      env,
      onData(data) {
        chunks.push(new Uint8Array(data));
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, idleMs);
      },
      onExit() {
        finish();
      },
    });

    setTimeout(() => {
      if (settled) return;
      proc.write(`${options.script}\rexit\r`);
    }, startupDelayMs);

    setTimeout(() => fail(new Error(`Timed out capturing PTY trace after ${timeoutMs}ms`)), timeoutMs);
  });
}
