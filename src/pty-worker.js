import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

let shellPty = null;
let exited = false;
let stdinBuffer = "";

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // ignore stdout errors during shutdown
  }
}

function logError(message) {
  try {
    process.stderr.write(`[pty-worker] ${message}\n`);
  } catch {
    // ignore stderr errors during shutdown
  }
}

function toBase64Utf8(data) {
  return Buffer.from(data, "utf8").toString("base64");
}

function fromBase64Utf8(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

function cleanupAndExit(code = 0) {
  if (exited) return;
  exited = true;

  if (shellPty) {
    try {
      shellPty.kill();
    } catch {
      // ignore
    }
    shellPty = null;
  }

  send({ type: "exit" });
  process.exit(code);
}

function handleCommand(command) {
  if (!command || typeof command !== "object" || typeof command.type !== "string") {
    return;
  }

  if (command.type === "spawn") {
    if (shellPty) return;

    const shell = typeof command.shell === "string" && command.shell.length > 0
      ? command.shell
      : (process.env.COMSPEC || "powershell.exe");
    const cwd = typeof command.cwd === "string" && command.cwd.length > 0 ? command.cwd : undefined;
    const cols = Number.isInteger(command.cols) && command.cols > 0 ? command.cols : 80;
    const rows = Number.isInteger(command.rows) && command.rows > 0 ? command.rows : 24;
    const env = command.env && typeof command.env === "object" ? command.env : process.env;

    try {
      shellPty = pty.spawn(shell, [], { cwd, cols, rows, env });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "error", message: `spawn failed: ${message}` });
      cleanupAndExit(1);
      return;
    }

    shellPty.onData((data) => {
      if (exited) return;
      send({ type: "data", data: toBase64Utf8(data) });
    });

    shellPty.onExit(() => {
      cleanupAndExit(0);
    });

    send({ type: "ready", pid: shellPty.pid });
    return;
  }

  if (!shellPty) return;

  if (command.type === "input" && typeof command.data === "string") {
    try {
      shellPty.write(fromBase64Utf8(command.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "error", message: `input failed: ${message}` });
    }
    return;
  }

  if (command.type === "resize") {
    const cols = Number.isInteger(command.cols) && command.cols > 0 ? command.cols : 0;
    const rows = Number.isInteger(command.rows) && command.rows > 0 ? command.rows : 0;
    if (!cols || !rows) return;
    try {
      shellPty.resize(cols, rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "error", message: `resize failed: ${message}` });
    }
    return;
  }

  if (command.type === "kill") {
    cleanupAndExit(0);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (exited) return;
  stdinBuffer += chunk;

  while (true) {
    const newline = stdinBuffer.indexOf("\n");
    if (newline === -1) break;

    const line = stdinBuffer.slice(0, newline).trim();
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (!line) continue;

    try {
      const command = JSON.parse(line);
      handleCommand(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`invalid command: ${message}`);
    }
  }
});

process.stdin.on("end", () => {
  cleanupAndExit(0);
});

process.stdin.on("error", (error) => {
  logError(`stdin error: ${error instanceof Error ? error.message : String(error)}`);
  cleanupAndExit(1);
});

process.on("SIGTERM", () => cleanupAndExit(0));
process.on("SIGINT", () => cleanupAndExit(0));
