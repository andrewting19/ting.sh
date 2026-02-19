import { randomUUID } from "crypto";

const PORT = parseInt(process.env.PORT ?? "7681");
const SHELL = process.env.SHELL ?? "zsh";
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB scrollback per session

interface Session {
  id: string;
  name: string;
  proc: ReturnType<typeof Bun.spawn>;
  buffer: Buffer;
  clients: Set<ServerWebSocket<WSData>>;
  createdAt: number;
}

interface WSData {
  sessionId: string | null;
}

// Persist sessions across Bun --hot reloads (globalThis survives module re-evaluation)
const g = globalThis as typeof globalThis & { __wt_sessions?: Map<string, Session> };
if (!g.__wt_sessions) g.__wt_sessions = new Map();
const sessions = g.__wt_sessions;

function sessionInfo(s: Session) {
  return { id: s.id, name: s.name, createdAt: s.createdAt, clients: s.clients.size };
}

function broadcastSessions() {
  const list = [...sessions.values()].map(sessionInfo);
  const msg = JSON.stringify({ type: "sessions", list });
  for (const s of sessions.values()) {
    for (const ws of s.clients) ws.send(msg);
  }
}

function createSession(name: string, cols: number, rows: number): Session {
  const id = randomUUID();
  const session: Session = {
    id,
    name: name?.trim() || `session ${sessions.size + 1}`,
    proc: null as any,
    buffer: Buffer.alloc(0),
    clients: new Set(),
    createdAt: Date.now(),
  };

  const proc = Bun.spawn([SHELL], {
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        // Append to scrollback buffer (capped)
        const combined = Buffer.concat([session.buffer, data]);
        session.buffer =
          combined.length > MAX_BUFFER
            ? combined.subarray(combined.length - MAX_BUFFER)
            : combined;

        // Broadcast raw bytes to all attached clients
        for (const ws of session.clients) ws.sendBinary(data);
      },
      exit() {
        sessions.delete(id);
        const msg = JSON.stringify({ type: "session-exit", id });
        for (const ws of session.clients) ws.send(msg);
        broadcastSessions();
      },
    },
  });

  session.proc = proc;
  sessions.set(id, session);
  return session;
}

const server = Bun.serve<WSData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { sessionId: null } })) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Serve built frontend (production: bun run build && bun run start)
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`./dist${filePath}`);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(_ws) {},

    message(ws, msg) {
      // Binary = terminal input from client (shouldn't happen but ignore)
      if (typeof msg !== "string") return;

      let data: any;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }

      const session = ws.data.sessionId ? sessions.get(ws.data.sessionId) : null;

      switch (data.type) {
        case "list": {
          ws.send(JSON.stringify({ type: "sessions", list: [...sessions.values()].map(sessionInfo) }));
          break;
        }

        case "create": {
          // Detach from any current session
          if (session) session.clients.delete(ws);

          const s = createSession(data.name ?? "", data.cols ?? 80, data.rows ?? 24);
          ws.data.sessionId = s.id;
          s.clients.add(ws);
          ws.send(JSON.stringify({ type: "ready", id: s.id, name: s.name, fresh: true }));
          broadcastSessions();
          break;
        }

        case "attach": {
          const s = sessions.get(data.id);
          if (!s) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            return;
          }

          // Detach from old session
          if (session && session !== s) session.clients.delete(ws);

          // Attach to new session
          ws.data.sessionId = s.id;
          s.clients.add(ws);

          // Resize to match client dimensions
          if (data.cols && data.rows) s.proc.terminal?.resize(data.cols, data.rows);

          // Replay scrollback
          if (s.buffer.length > 0) ws.sendBinary(s.buffer);

          ws.send(JSON.stringify({ type: "ready", id: s.id, name: s.name }));
          break;
        }

        case "input": {
          if (!session) return;
          session.proc.terminal?.write(data.data);
          break;
        }

        case "resize": {
          if (!session) return;
          session.proc.terminal?.resize(data.cols, data.rows);
          break;
        }

        case "rename": {
          const s = sessions.get(data.id);
          if (!s) return;
          s.name = (data.name ?? "").trim() || s.name;
          broadcastSessions();
          break;
        }

        case "kill": {
          const s = sessions.get(data.id);
          if (!s) return;
          sessions.delete(data.id);
          const exitMsg = JSON.stringify({ type: "session-exit", id: data.id });
          for (const c of s.clients) c.send(exitMsg);
          s.proc.terminal?.close();
          s.proc.kill();
          broadcastSessions();
          break;
        }
      }
    },

    close(ws) {
      const session = ws.data.sessionId ? sessions.get(ws.data.sessionId) : null;
      if (session) session.clients.delete(ws);
    },
  },
});

console.log(`web-terminal listening on http://localhost:${server.port}`);
