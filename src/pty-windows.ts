import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PtyProcess, PtySpawnOptions } from "./pty";

type WorkerOutboundMessage =
  | {
      type: "spawn";
      shell: string;
      cwd?: string;
      cols: number;
      rows: number;
      env?: Record<string, string>;
    }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill" };

type WorkerInboundMessage =
  | { type: "ready"; pid: number }
  | { type: "data"; data: string }
  | { type: "exit" }
  | { type: "error"; message: string };

const textEncoder = new TextEncoder();
const workerPath = fileURLToPath(new URL("./pty-worker.js", import.meta.url));
const bundledNodePath = fileURLToPath(new URL("../node/node.exe", import.meta.url));

function findNodeExecutable(): string {
  if (existsSync(bundledNodePath)) return bundledNodePath;

  const pathValue = process.env.PATH || "";
  const pathEntries = pathValue.split(delimiter).filter(Boolean);
  const pathCandidates = ["node.exe", "node.cmd", "node.bat", "node"];

  for (const dir of pathEntries) {
    const normalizedDir = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!normalizedDir) continue;
    for (const candidate of pathCandidates) {
      const fullPath = join(normalizedDir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }

  const commonCandidates = [
    process.env["ProgramFiles"] ? join(process.env["ProgramFiles"], "nodejs", "node.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe") : "",
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    "C:\\nodejs\\node.exe",
  ];
  for (const candidate of commonCandidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  return "node";
}

function decodeBase64(data: string): Uint8Array {
  return Buffer.from(data, "base64");
}

function encodeBase64(data: Uint8Array | string): string {
  if (typeof data === "string") {
    return Buffer.from(textEncoder.encode(data)).toString("base64");
  }
  return Buffer.from(data).toString("base64");
}

function parseWorkerMessage(line: string): WorkerInboundMessage | null {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.type === "ready" && typeof record.pid === "number") {
      return { type: "ready", pid: record.pid };
    }
    if (record.type === "data" && typeof record.data === "string") {
      return { type: "data", data: record.data };
    }
    if (record.type === "exit") {
      return { type: "exit" };
    }
    if (record.type === "error" && typeof record.message === "string") {
      return { type: "error", message: record.message };
    }
    return null;
  } catch {
    return null;
  }
}

export function spawnPty(options: PtySpawnOptions): PtyProcess {
  const shell = options.shell ?? process.env.COMSPEC ?? "powershell.exe";
  const nodePath = findNodeExecutable();

  let worker: ReturnType<typeof Bun.spawn>;
  try {
    worker = Bun.spawn([nodePath, workerPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pty-windows] failed to start node sidecar (${nodePath}): ${message}`);
    queueMicrotask(() => options.onExit());
    return {
      pid: -1,
      write() {
        // no-op when sidecar startup fails
      },
      resize() {
        // no-op when sidecar startup fails
      },
      kill() {
        // no-op when sidecar startup fails
      },
    };
  }

  let ptyPid = worker.pid;
  let exited = false;

  const finalize = () => {
    if (exited) return;
    exited = true;
    try {
      worker.stdin?.end();
    } catch {
      // ignore
    }
    options.onExit();
  };

  const send = (msg: WorkerOutboundMessage) => {
    if (exited) return;
    try {
      worker.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch {
      finalize();
    }
  };

  void (async () => {
    if (!worker.stdout) return;

    const streamDecoder = new TextDecoder();
    const reader = worker.stdout.getReader();
    let buffered = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += streamDecoder.decode(value, { stream: true });

        while (true) {
          const newlineIndex = buffered.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = buffered.slice(0, newlineIndex).trim();
          buffered = buffered.slice(newlineIndex + 1);
          if (!line) continue;

          const msg = parseWorkerMessage(line);
          if (!msg) continue;

          if (msg.type === "ready") {
            ptyPid = msg.pid;
            continue;
          }

          if (msg.type === "data") {
            if (exited) continue;
            options.onData(decodeBase64(msg.data));
            continue;
          }

          if (msg.type === "error") {
            console.error(`[pty-windows] worker error: ${msg.message}`);
            continue;
          }

          if (msg.type === "exit") {
            finalize();
          }
        }
      }

      // Flush any remaining decoded text after stream end.
      buffered += streamDecoder.decode();
      const line = buffered.trim();
      if (line) {
        const msg = parseWorkerMessage(line);
        if (msg?.type === "ready") ptyPid = msg.pid;
        if (msg?.type === "data" && !exited) options.onData(decodeBase64(msg.data));
      }
    } catch {
      // worker exited mid-stream
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      finalize();
    }
  })();

  void (async () => {
    if (!worker.stderr) return;
    const text = await new Response(worker.stderr).text();
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      console.error(`[pty-windows] worker stderr: ${trimmed}`);
    }
  })();

  void worker.exited.then(() => {
    finalize();
  });

  send({
    type: "spawn",
    shell,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: options.env,
  });

  return {
    get pid() {
      return ptyPid;
    },
    write(data) {
      if (exited) return;
      send({ type: "input", data: encodeBase64(data) });
    },
    resize(cols, rows) {
      if (exited) return;
      send({ type: "resize", cols, rows });
    },
    kill() {
      if (exited) return;
      send({ type: "kill" });
      setTimeout(() => {
        if (exited) return;
        try {
          worker.kill();
        } catch {
          // ignore
        }
      }, 200);
    },
  };
}
