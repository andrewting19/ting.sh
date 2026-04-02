import { existsSync } from "fs";
import { defaultCwd, defaultShell, prepareEnvForShell, spawnPty } from "../pty";

export interface PtyTraceCapture {
  cols: number;
  rows: number;
  finalCols: number;
  finalRows: number;
  chunks: Uint8Array[];
  combined: Buffer;
  events: PtyTraceEvent[];
}

export type PtyTraceEvent =
  | { type: "data"; data: Uint8Array }
  | { type: "resize"; cols: number; rows: number };

export interface CapturePtyTraceOptions {
  script: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  startupDelayMs?: number;
  idleMs?: number;
  timeoutMs?: number;
  steps?: PtyTraceStep[];
}

export type PtyTraceStep =
  | { type: "write"; data: string; delayMs?: number }
  | { type: "resize"; cols: number; rows: number; delayMs?: number }
  | { type: "exit"; delayMs?: number };

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
  const events: PtyTraceEvent[] = [];
  let currentCols = cols;
  let currentRows = rows;

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
        finalCols: currentCols,
        finalRows: currentRows,
        chunks,
        combined: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        events,
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
        const chunk = new Uint8Array(data);
        chunks.push(chunk);
        events.push({ type: "data", data: chunk });
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, idleMs);
      },
      onExit() {
        finish();
      },
    });

    void (async () => {
      await Bun.sleep(startupDelayMs);
      if (settled) return;
      if (options.steps && options.steps.length > 0) {
        for (const step of options.steps) {
          await Bun.sleep(step.delayMs ?? 0);
          if (settled) return;
          if (step.type === "write") {
            proc.write(step.data);
            continue;
          }
          if (step.type === "resize") {
            currentCols = step.cols;
            currentRows = step.rows;
            events.push({ type: "resize", cols: step.cols, rows: step.rows });
            proc.resize(step.cols, step.rows);
            continue;
          }
          proc.write("exit\r");
        }
        return;
      }
      proc.write(`${options.script}\rexit\r`);
    })();

    setTimeout(() => fail(new Error(`Timed out capturing PTY trace after ${timeoutMs}ms`)), timeoutMs);
  });
}
