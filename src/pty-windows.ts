import * as pty from "node-pty";
import type { PtyProcess, PtySpawnOptions } from "./pty";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function spawnPty(options: PtySpawnOptions): PtyProcess {
  const shell = options.shell ?? process.env.COMSPEC ?? "powershell.exe";
  const proc = pty.spawn(shell, [], {
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows,
  });

  let exited = false;

  proc.onData((data) => {
    options.onData(encoder.encode(data));
  });

  proc.onExit(() => {
    exited = true;
    options.onExit();
  });

  return {
    pid: proc.pid,
    write(data) {
      if (exited) return;
      try {
        proc.write(typeof data === "string" ? data : decoder.decode(data));
      } catch { /* socket already closed */ }
    },
    resize(cols, rows) {
      if (exited) return;
      try { proc.resize(cols, rows); } catch { /* ignore */ }
    },
    kill() {
      if (exited) return;
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}
