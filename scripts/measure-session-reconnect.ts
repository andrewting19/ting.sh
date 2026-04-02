import { renderedTextSnapshotToVt, type RenderedTextSnapshot } from "../src/snapshot/renderedTextSnapshot";

interface AttachMeasurement {
  mode: "raw" | "snapshot";
  sessionId: string;
  sessionName: string | null;
  backend: string | null;
  replayBytesExpected: number | null;
  snapshotBytes: number | null;
  replayBytesReceived: number;
  replayChunkCount: number;
  tailBytesReceived: number;
  tailChunkCount: number;
  requestedAt: number;
  readyAt: number | null;
  firstByteAt: number | null;
  completeAt: number | null;
  durationMs: number | null;
}

interface DebugSnapshotShape {
  cols?: number;
  rows?: number;
}

interface SessionListItem {
  id: string;
  name: string;
}

interface DebugSessionShape {
  snapshot?: DebugSnapshotShape;
  renderedTextSnapshot?: DebugSnapshotShape;
}

function getServerWsUrl(): string {
  const host = process.env.SERVER_HOST?.trim() || "127.0.0.1";
  const port = parseInt(process.env.SERVER_PORT?.trim() || process.env.PORT?.trim() || "7681", 10);
  return `ws://${host}:${port}/ws`;
}

function getServerHttpUrl(): string {
  const host = process.env.SERVER_HOST?.trim() || "127.0.0.1";
  const port = parseInt(process.env.SERVER_PORT?.trim() || process.env.PORT?.trim() || "7681", 10);
  return `http://${host}:${port}`;
}

function usage(): never {
  console.error("usage: bun run scripts/measure-session-reconnect.ts <session-id> [renderer]");
  console.error("   or: bun run scripts/measure-session-reconnect.ts --all [renderer]");
  process.exit(1);
}

function now(): number {
  return performance.now();
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function snapshotSize(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const record = snapshot as Record<string, unknown>;
  if (typeof record.payload === "string") return record.payload.length;
  if (record.format === "rendered-text-snapshot-v1") {
    return renderedTextSnapshotToVt(snapshot as RenderedTextSnapshot).length;
  }
  try {
    return JSON.stringify(snapshot).length;
  } catch {
    return null;
  }
}

async function resolveAttachDimensions(sessionId: string): Promise<{ cols: number; rows: number }> {
  try {
    const url = new URL(`${getServerHttpUrl()}/api/debug/session`);
    url.searchParams.set("id", sessionId);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`debug session fetch failed: ${res.status}`);
    const debug = await res.json() as DebugSessionShape;
    const cols = debug.snapshot?.cols ?? debug.renderedTextSnapshot?.cols;
    const rows = debug.snapshot?.rows ?? debug.renderedTextSnapshot?.rows;
    if (typeof cols === "number" && cols > 0 && typeof rows === "number" && rows > 0) {
      return { cols, rows };
    }
  } catch {
    // fall back to historical default if debug metadata is unavailable
  }
  return { cols: 80, rows: 24 };
}

async function listSessions(): Promise<SessionListItem[]> {
  const ws = new WebSocket(getServerWsUrl());

  return await new Promise<SessionListItem[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      reject(new Error("Timed out listing sessions"));
    }, 10_000);

    const finish = (value: SessionListItem[]) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      resolve(value);
    };

    const fail = (err: Error) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      reject(err);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "list" }));
    };

    ws.onerror = () => {
      fail(new Error("WebSocket failed while listing sessions"));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (parsed.type !== "sessions" || !Array.isArray(parsed.list)) return;
      const list = parsed.list.flatMap((item): SessionListItem[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.name !== "string") return [];
        return [{ id: record.id, name: record.name }];
      });
      finish(list);
    };
  });
}

async function measureRawAttach(sessionId: string): Promise<AttachMeasurement> {
  const dims = await resolveAttachDimensions(sessionId);
  const ws = new WebSocket(getServerWsUrl());
  ws.binaryType = "arraybuffer";
  const requestId = makeRequestId("raw");

  return await new Promise<AttachMeasurement>((resolve, reject) => {
    const requestedAt = now();
    let settled = false;
    let completeTimer: ReturnType<typeof setTimeout> | null = null;
    const measurement: AttachMeasurement = {
      mode: "raw",
      sessionId,
      sessionName: null,
      backend: null,
      replayBytesExpected: null,
      snapshotBytes: null,
      replayBytesReceived: 0,
      replayChunkCount: 0,
      tailBytesReceived: 0,
      tailChunkCount: 0,
      requestedAt,
      readyAt: null,
      firstByteAt: null,
      completeAt: null,
      durationMs: null,
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (completeTimer) clearTimeout(completeTimer);
      measurement.completeAt = now();
      measurement.durationMs = measurement.completeAt - requestedAt;
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      resolve(measurement);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (completeTimer) clearTimeout(completeTimer);
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      reject(err);
    };

    const armIdleCompletion = () => {
      if (completeTimer) clearTimeout(completeTimer);
      completeTimer = setTimeout(finish, 250);
    };

    const timeout = setTimeout(() => fail(new Error("Timed out measuring raw attach")), 10_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "attach", id: sessionId, cols: dims.cols, rows: dims.rows, requestId }));
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      fail(new Error("WebSocket failed during raw attach"));
    };

    ws.onmessage = (event) => {
      if (settled) return;
      if (event.data instanceof ArrayBuffer) {
        if (measurement.firstByteAt === null) measurement.firstByteAt = now();
        measurement.replayBytesReceived += event.data.byteLength;
        measurement.replayChunkCount += 1;
        armIdleCompletion();
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (parsed.type === "host-info" || parsed.type === "sessions") return;
      if (parsed.type === "error") {
        clearTimeout(timeout);
        fail(new Error(String(parsed.message ?? "Attach failed")));
        return;
      }
      if (parsed.type !== "ready" || parsed.requestId !== requestId) return;
      clearTimeout(timeout);
      measurement.readyAt = now();
      measurement.sessionName = typeof parsed.name === "string" ? parsed.name : null;
      measurement.replayBytesExpected = typeof parsed.replayBytes === "number" ? parsed.replayBytes : null;
      if ((measurement.replayBytesExpected ?? 0) === 0) {
        finish();
        return;
      }
      armIdleCompletion();
    };

    const originalOnMessage = ws.onmessage;
    ws.onmessage = (event) => {
      originalOnMessage?.(event);
      if (settled) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      if (
        measurement.replayBytesExpected !== null &&
        measurement.replayBytesReceived >= measurement.replayBytesExpected
      ) {
        clearTimeout(timeout);
        finish();
      }
    };
  });
}

async function measureSnapshotAttach(sessionId: string, renderer: string): Promise<AttachMeasurement> {
  const dims = await resolveAttachDimensions(sessionId);
  const ws = new WebSocket(getServerWsUrl());
  ws.binaryType = "arraybuffer";
  const requestId = makeRequestId("snap");

  return await new Promise<AttachMeasurement>((resolve, reject) => {
    const requestedAt = now();
    let settled = false;
    const measurement: AttachMeasurement = {
      mode: "snapshot",
      sessionId,
      sessionName: null,
      backend: null,
      replayBytesExpected: null,
      snapshotBytes: null,
      replayBytesReceived: 0,
      replayChunkCount: 0,
      tailBytesReceived: 0,
      tailChunkCount: 0,
      requestedAt,
      readyAt: null,
      firstByteAt: null,
      completeAt: null,
      durationMs: null,
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      measurement.completeAt = now();
      measurement.durationMs = measurement.completeAt - requestedAt;
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      resolve(measurement);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      reject(err);
    };

    const timeout = setTimeout(() => fail(new Error("Timed out measuring snapshot attach")), 10_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "attach-snapshot",
        id: sessionId,
        cols: dims.cols,
        rows: dims.rows,
        requestId,
        renderer,
      }));
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      fail(new Error("WebSocket failed during snapshot attach"));
    };

    ws.onmessage = (event) => {
      if (settled) return;
      if (event.data instanceof ArrayBuffer) {
        if (measurement.firstByteAt === null) measurement.firstByteAt = now();
        measurement.replayBytesReceived += event.data.byteLength;
        measurement.replayChunkCount += 1;
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (parsed.type === "host-info" || parsed.type === "sessions") return;
      if (parsed.type === "error") {
        clearTimeout(timeout);
        fail(new Error(String(parsed.message ?? "Snapshot attach failed")));
        return;
      }
      if (parsed.type === "snapshot-ready" && parsed.requestId === requestId) {
        measurement.readyAt = now();
        measurement.sessionName = typeof parsed.name === "string" ? parsed.name : null;
        measurement.backend = typeof parsed.backend === "string" ? parsed.backend : null;
        measurement.snapshotBytes = snapshotSize(parsed.snapshot);
        ws.send(JSON.stringify({ type: "snapshot-applied", id: sessionId, requestId }));
        return;
      }
      if (parsed.type === "snapshot-tail" && parsed.requestId === requestId) {
        const data = typeof parsed.data === "string" ? parsed.data : "";
        if (data) {
          if (measurement.firstByteAt === null) measurement.firstByteAt = now();
          measurement.tailBytesReceived += Buffer.from(data, "base64").length;
          measurement.tailChunkCount += 1;
        }
        return;
      }
      if (parsed.type === "snapshot-complete" && parsed.requestId === requestId) {
        clearTimeout(timeout);
        finish();
      }
    };
  });
}

const target = process.argv[2];
if (!target) usage();

const renderer = process.argv[3] ?? "xterm";

if (target === "--all") {
  const sessions = await listSessions();
  const results = [];
  for (const session of sessions) {
    const raw = await measureRawAttach(session.id);
    const snapshot = await measureSnapshotAttach(session.id, renderer);
    results.push({
      sessionId: session.id,
      sessionName: session.name,
      renderer,
      raw,
      snapshot,
    });
  }

  console.log(JSON.stringify({
    renderer,
    sessionCount: sessions.length,
    results,
  }, null, 2));
} else {
  const sessionId = target;
  const raw = await measureRawAttach(sessionId);
  const snapshot = await measureSnapshotAttach(sessionId, renderer);

  console.log(JSON.stringify({
    sessionId,
    renderer,
    raw,
    snapshot,
  }, null, 2));
}
