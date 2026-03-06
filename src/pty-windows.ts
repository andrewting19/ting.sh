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

  proc.onData((data) => {
    options.onData(encoder.encode(data));
  });

  proc.onExit(() => {
    options.onExit();
  });

  return {
    pid: proc.pid,
    write(data) {
      proc.write(typeof data === "string" ? data : decoder.decode(data));
    },
    resize(cols, rows) {
      proc.resize(cols, rows);
    },
    kill() {
      proc.kill();
    },
  };
}
