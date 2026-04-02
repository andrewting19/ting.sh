import { randomUUID } from "crypto";
import { readlinkSync } from "fs";
import { getReplayBufferStats } from "./serverBuffer";
import { resolvePtydPort } from "./src/sidecarConfig";
import { defaultCwd, defaultShell, prepareEnvForShell, spawnPty, type PtyProcess } from "./src/pty";
import { pickUniqueSessionName } from "./src/sessionNames";
import { XtermVtSnapshotTracker } from "./src/snapshot/xtermVtSnapshot";
import { isGitBashShell, stripWindowsCwdControlFrames } from "./src/windowsShellIntegration";

const PORT = resolvePtydPort();
const MAX_BUFFER = parseInt(process.env.MAX_BUFFER_BYTES ?? String(10 * 1024 * 1024), 10);
const IDLE_EXIT_MS = parseInt(process.env.PTYD_IDLE_EXIT_MS ?? "0", 10);

interface Session {
  id: string;
  name: string;
  proc: PtyProcess | null;
  shell: string;
  buffer: Buffer;
  bufferTrimmed: boolean;
  snapshotTracker: XtermVtSnapshotTracker;
  clients: Set<ServerWebSocket<WSData>>;
  createdAt: number;
  cwd: string;
  cwdTimer: ReturnType<typeof setTimeout> | null;
  shellControlRemainder: string;
  shellTracksCwd: boolean;
}

interface WSData {
  sessionId: string | null;
}

type ParsedClientMessage = { type: string } & Record<string, unknown>;

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n > 0 ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function getCwd(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") return null;
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      const match = text.match(/^n(.+)$/m);
      return match ? match[1].trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

const CWD_REFRESH_RETRY_DELAYS_MS = [200, 400, 800];
const sessions = new Map<string, Session>();
const listSubscribers = new Set<ServerWebSocket<WSData>>();
let idleExitTimer: ReturnType<typeof setTimeout> | null = null;

function maybeScheduleIdleExit() {
  if (IDLE_EXIT_MS <= 0) return;
  if (idleExitTimer) clearTimeout(idleExitTimer);
  if (sessions.size > 0) return;
  if (listSubscribers.size > 0) return;
  idleExitTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
}

function cancelIdleExit() {
  if (!idleExitTimer) return;
  clearTimeout(idleExitTimer);
  idleExitTimer = null;
}

function pickSessionName(): string {
  return pickUniqueSessionName([...sessions.values()].map((session) => session.name));
}

function sessionInfo(session: Session) {
  return {
    id: session.id,
    hostId: "local",
    name: session.name,
    createdAt: session.createdAt,
    clients: session.clients.size,
    cwd: session.cwd,
  };
}

function detachClient(ws: ServerWebSocket<WSData>): boolean {
  const sessionId = ws.data.sessionId;
  if (!sessionId) return false;
  ws.data.sessionId = null;
  const session = sessions.get(sessionId);
  if (!session) return false;
  const removed = session.clients.delete(ws);
  maybeScheduleIdleExit();
  return removed;
}

function safeSend(ws: ServerWebSocket<WSData>, payload: string): boolean {
  try {
    ws.send(payload);
    return true;
  } catch {
    listSubscribers.delete(ws);
    detachClient(ws);
    maybeScheduleIdleExit();
    return false;
  }
}

function broadcastSessions() {
  const list = [...sessions.values()].map(sessionInfo);
  const msg = JSON.stringify({ type: "sessions", list });
  const recipients = new Set<ServerWebSocket<WSData>>(listSubscribers);
  for (const session of sessions.values()) {
    for (const ws of session.clients) recipients.add(ws);
  }
  for (const ws of recipients) safeSend(ws, msg);
  maybeScheduleIdleExit();
}

function scheduleCwdRefresh(session: Session) {
  if (session.cwdTimer) clearTimeout(session.cwdTimer);
  const baselineCwd = session.cwd;
  let attempt = 0;

  const refresh = async () => {
    session.cwdTimer = null;
    if (!session.proc) return;
    const cwd = await getCwd(session.proc.pid);
    if (cwd && cwd !== session.cwd) {
      session.cwd = cwd;
      broadcastSessions();
      return;
    }
    if (session.cwd !== baselineCwd) return;
    attempt += 1;
    if (attempt >= CWD_REFRESH_RETRY_DELAYS_MS.length) return;
    session.cwdTimer = setTimeout(refresh, CWD_REFRESH_RETRY_DELAYS_MS[attempt]);
  };

  session.cwdTimer = setTimeout(refresh, CWD_REFRESH_RETRY_DELAYS_MS[attempt]);
}

function createSession(name: string, cols: number, rows: number, cwd?: string): Session {
  cancelIdleExit();
  const id = randomUUID();
  const shell = defaultShell();
  const session: Session = {
    id,
    name: name.trim() || pickSessionName(),
    proc: null,
    shell,
    buffer: Buffer.alloc(0),
    bufferTrimmed: false,
    snapshotTracker: new XtermVtSnapshotTracker(cols, rows),
    clients: new Set(),
    createdAt: Date.now(),
    cwd: "",
    cwdTimer: null,
    shellControlRemainder: "",
    shellTracksCwd: process.platform === "win32" && isGitBashShell(shell),
  };

  const baseEnv = Object.fromEntries(
    Object.entries({ ...process.env, TERM: "xterm-256color" }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  const env = prepareEnvForShell(shell, baseEnv);

  const proc = spawnPty({
    shell,
    cwd: cwd || defaultCwd(),
    cols,
    rows,
    env,
    onData(data) {
      let payload = Buffer.from(data);
      if (session.shellTracksCwd) {
        const extracted = stripWindowsCwdControlFrames(payload, session.shellControlRemainder);
        payload = Buffer.from(extracted.data);
        session.shellControlRemainder = extracted.remainder;
        if (extracted.cwd && extracted.cwd !== session.cwd) {
          session.cwd = extracted.cwd;
          broadcastSessions();
        }
      }

      const combined = Buffer.concat([session.buffer, payload]);
      if (combined.length > MAX_BUFFER) {
        session.buffer = combined.subarray(combined.length - MAX_BUFFER);
        session.bufferTrimmed = true;
      } else {
        session.buffer = combined;
      }

      if (payload.length > 0) {
        void session.snapshotTracker.write(payload);
        for (const ws of session.clients) ws.sendBinary(payload);
      }
    },
    onExit() {
      if (session.cwdTimer) clearTimeout(session.cwdTimer);
      sessions.delete(id);
      const msg = JSON.stringify({ type: "session-exit", id });
      for (const ws of session.clients) ws.send(msg);
      broadcastSessions();
    },
  });

  session.proc = proc;
  sessions.set(id, session);
  getCwd(proc.pid).then((nextCwd) => {
    if (nextCwd) {
      session.cwd = nextCwd;
      broadcastSessions();
    }
  });

  return session;
}

setInterval(async () => {
  let changed = false;
  await Promise.all(
    [...sessions.values()].map(async (session) => {
      if (!session.proc) return;
      const cwd = await getCwd(session.proc.pid);
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        changed = true;
      }
    })
  );
  if (changed) broadcastSessions();
}, 30_000);

const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "127.0.0.1",

  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { sessionId: null } })) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, sessions: sessions.size, pid: process.pid });
    }
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open() {
      cancelIdleExit();
    },

    message(ws, msg) {
      if (typeof msg !== "string") return;
      let data: ParsedClientMessage;
      try {
        const parsed = JSON.parse(msg);
        if (!parsed || typeof parsed !== "object") return;
        const record = parsed as Record<string, unknown>;
        if (typeof record.type !== "string") return;
        data = record as ParsedClientMessage;
      } catch {
        return;
      }

      const session = ws.data.sessionId ? sessions.get(ws.data.sessionId) : null;
      switch (data.type) {
        case "list": {
          listSubscribers.add(ws);
          ws.send(JSON.stringify({ type: "sessions", list: [...sessions.values()].map(sessionInfo) }));
          break;
        }

        case "detach": {
          if (detachClient(ws)) broadcastSessions();
          break;
        }

        case "create": {
          if (session) session.clients.delete(ws);
          const name = asString(data.name) ?? "";
          const cols = asPositiveInt(data.cols) ?? 80;
          const rows = asPositiveInt(data.rows) ?? 24;
          const cwdRaw = asString(data.cwd);
          const cwd = cwdRaw && cwdRaw.trim().length > 0 ? cwdRaw : undefined;
          const requestId = asString(data.requestId);
          const created = createSession(name, cols, rows, cwd);
          const replay = getReplayBufferStats(created.buffer, created.bufferTrimmed);
          ws.data.sessionId = created.id;
          broadcastSessions();
          ws.send(JSON.stringify({
            type: "ready",
            id: created.id,
            name: created.name,
            fresh: true,
            replayBytes: replay.replayBytes,
            replayLineBreaks: replay.replayLineBreaks,
            replayTrimmed: replay.replayTrimmed,
            ...(requestId !== null ? { requestId } : {}),
          }));
          created.clients.add(ws);
          if (replay.replayBytes > 0) ws.sendBinary(replay.replay);
          broadcastSessions();
          break;
        }

        case "attach": {
          const id = asString(data.id);
          const requestId = asString(data.requestId);
          const target = id ? sessions.get(id) : null;
          if (!target) {
            ws.send(JSON.stringify({
              type: "error",
              message: "Session not found",
              ...(requestId !== null ? { requestId } : {}),
            }));
            return;
          }
          if (session && session !== target) session.clients.delete(ws);
          ws.data.sessionId = target.id;
          target.clients.add(ws);
          broadcastSessions();
          const cols = asPositiveInt(data.cols);
          const rows = asPositiveInt(data.rows);
          if (cols && rows) target.proc?.resize(cols, rows);
          if (cols && rows) target.snapshotTracker.resize(cols, rows);
          const replay = getReplayBufferStats(target.buffer, target.bufferTrimmed);
          ws.send(JSON.stringify({
            type: "ready",
            id: target.id,
            name: target.name,
            replayBytes: replay.replayBytes,
            replayLineBreaks: replay.replayLineBreaks,
            replayTrimmed: replay.replayTrimmed,
            ...(requestId !== null ? { requestId } : {}),
          }));
          if (replay.replayBytes > 0) ws.sendBinary(replay.replay);
          break;
        }

        case "input": {
          const input = asString(data.data);
          if (!session || input === null) return;
          session.proc?.write(input);
          if (input === "\r") scheduleCwdRefresh(session);
          break;
        }

        case "resize": {
          const cols = asPositiveInt(data.cols);
          const rows = asPositiveInt(data.rows);
          if (!session || !cols || !rows) return;
          session.proc?.resize(cols, rows);
          session.snapshotTracker.resize(cols, rows);
          break;
        }

        case "rename": {
          const id = asString(data.id);
          if (!id) return;
          const target = sessions.get(id);
          if (!target) return;
          const nextName = asString(data.name);
          target.name = (nextName ?? "").trim() || target.name;
          broadcastSessions();
          break;
        }

        case "kill": {
          const id = asString(data.id);
          if (!id) return;
          const target = sessions.get(id);
          if (!target) return;
          if (target.cwdTimer) clearTimeout(target.cwdTimer);
          sessions.delete(id);
          const exitMsg = JSON.stringify({ type: "session-exit", id });
          for (const client of target.clients) client.send(exitMsg);
          target.proc?.kill();
          broadcastSessions();
          break;
        }
      }
    },

    close(ws) {
      detachClient(ws);
      listSubscribers.delete(ws);
      maybeScheduleIdleExit();
    },
  },
});

console.log(`[ptyd] listening on http://127.0.0.1:${server.port}`);
