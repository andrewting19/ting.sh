import type { PtyProcess, PtySpawnOptions } from "./pty";

export function spawnPty(options: PtySpawnOptions): PtyProcess {
  const shell = options.shell ?? (process.env.SHELL || "zsh");
  const proc = Bun.spawn([shell], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data(_terminal, data) {
        options.onData(data);
      },
      exit() {
        options.onExit();
      },
    },
  });

  return {
    pid: proc.pid,
    write(data) {
      proc.terminal?.write(data);
    },
    resize(cols, rows) {
      proc.terminal?.resize(cols, rows);
    },
    kill() {
      proc.terminal?.close();
      proc.kill();
    },
  };
}
