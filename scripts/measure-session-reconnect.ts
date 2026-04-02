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

function getServerWsUrl(): string {
  const host = process.env.SERVER_HOST?.trim() || "127.0.0.1";
  const port = parseInt(process.env.SERVER_PORT?.trim() || process.env.PORT?.trim() || "7681", 10);
  return `ws://${host}:${port}/ws`;
}

function usage(): never {
  console.error("usage: bun run scripts/measure-session-reconnect.ts <session-id> [renderer]");
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

async function measureRawAttach(sessionId: string): Promise<AttachMeasurement> {
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
      ws.send(JSON.stringify({ type: "attach", id: sessionId, cols: 80, rows: 24, requestId }));
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
      armIdleCompletion();
    };
  });
}

async function measureSnapshotAttach(sessionId: string, renderer: string): Promise<AttachMeasurement> {
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
        cols: 80,
        rows: 24,
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

const sessionId = process.argv[2];
if (!sessionId) usage();

const renderer = process.argv[3] ?? "xterm";
const raw = await measureRawAttach(sessionId);
const snapshot = await measureSnapshotAttach(sessionId, renderer);

console.log(JSON.stringify({
  sessionId,
  renderer,
  raw,
  snapshot,
}, null, 2));
