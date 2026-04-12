import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { getPtydHttpBaseUrl } from "../src/sidecarConfig";
import { resolveServerPort } from "../src/serverPort";

interface DebugSessionCapture {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  initialCols: number;
  initialRows: number;
  outputSeq: number;
  snapshotSeq: number;
  bufferBytes: number;
  bufferTrimmed: boolean;
  liveTailBytes: number;
  liveTailSeq: number;
  traceEventCount: number;
  traceDataBytes: number;
  traceEvents: Array<
    | { type: "data"; base64: string; bytes: number }
    | { type: "resize"; cols: number; rows: number }
  >;
  snapshotBytes: number;
  renderedTextSnapshotBytes: number;
  snapshot: {
    format: string;
    cols: number;
    rows: number;
    payload: string;
    capturedAt: number;
  };
  renderedTextSnapshot: {
    format: string;
    cols: number;
    rows: number;
    activeBuffer: string;
  };
  canonicalSnapshot: {
    format: string;
    cols: number;
    rows: number;
    activeBuffer: string;
  };
  rawReplayBase64?: string;
}

interface SessionListItem {
  id: string;
  name: string;
}

function usage(): never {
  console.error("usage: bun run scripts/capture-session-trace.ts <session-id> [output-path]");
  console.error("   or: bun run scripts/capture-session-trace.ts --all [output-dir]");
  process.exit(1);
}

function getServerBaseUrl(): string {
  const host = process.env.SERVER_HOST?.trim() || "127.0.0.1";
  const port = parseInt(process.env.SERVER_PORT?.trim() || String(resolveServerPort()), 10);
  return `http://${host}:${port}`
}

async function fetchCapture(sessionId: string): Promise<Response> {
  const serverUrl = new URL(`${getServerBaseUrl()}/api/debug/session`);
  serverUrl.searchParams.set("id", sessionId);
  serverUrl.searchParams.set("includeRaw", "1");
  try {
    const serverRes = await fetch(serverUrl);
    if (serverRes.ok) return serverRes;
    if (serverRes.status !== 404 && serverRes.status !== 502) return serverRes;
  } catch {
    // fall through to direct sidecar access
  }

  const ptydBaseUrl = getPtydHttpBaseUrl();
  return await fetch(`${ptydBaseUrl}/debug/session?id=${encodeURIComponent(sessionId)}&includeRaw=1`);
}

async function listSessions(): Promise<SessionListItem[]> {
  const ws = new WebSocket(`${getServerBaseUrl().replace(/^http/, "ws")}/ws`);

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
      if (parsed.type === "host-info") return;
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

const target = process.argv[2];
if (!target) usage();

if (target === "--all") {
  const outputDir = resolve(process.argv[3] ?? `captures/batch-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const sessions = await listSessions();
  const results = [];

  for (const session of sessions) {
    const res = await fetchCapture(session.id);
    if (!res.ok) {
      results.push({
        sessionId: session.id,
        name: session.name,
        error: `${res.status} ${res.statusText}`,
      });
      continue;
    }
    const capture = await res.json() as DebugSessionCapture;
    const outputPath = resolve(outputDir, `${capture.name}-${capture.id}.json`);
    await Bun.write(outputPath, `${JSON.stringify(capture, null, 2)}\n`);
    results.push({
      sessionId: capture.id,
      name: capture.name,
      outputSeq: capture.outputSeq,
      snapshotSeq: capture.snapshotSeq,
      initialCols: capture.initialCols,
      initialRows: capture.initialRows,
      bufferBytes: capture.bufferBytes,
      snapshotBytes: capture.snapshotBytes,
      renderedTextSnapshotBytes: capture.renderedTextSnapshotBytes,
      activeBuffer: capture.renderedTextSnapshot.activeBuffer,
      liveTailBytes: capture.liveTailBytes,
      traceEventCount: capture.traceEventCount,
      traceDataBytes: capture.traceDataBytes,
      outputPath,
    });
  }

  console.log(JSON.stringify({
    sessionCount: sessions.length,
    outputDir,
    results,
  }, null, 2));
  process.exit(0);
}

const sessionId = target;
const outputPath = resolve(process.argv[3] ?? `captures/session-${sessionId}-${Date.now()}.json`);
const res = await fetchCapture(sessionId);
if (!res.ok) {
  console.error(`failed to capture session ${sessionId}: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const capture = await res.json() as DebugSessionCapture;
mkdirSync(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(capture, null, 2)}\n`);

console.log(JSON.stringify({
  sessionId: capture.id,
  name: capture.name,
  outputSeq: capture.outputSeq,
  snapshotSeq: capture.snapshotSeq,
  initialCols: capture.initialCols,
  initialRows: capture.initialRows,
  bufferBytes: capture.bufferBytes,
  snapshotBytes: capture.snapshotBytes,
  renderedTextSnapshotBytes: capture.renderedTextSnapshotBytes,
  activeBuffer: capture.renderedTextSnapshot.activeBuffer,
  liveTailBytes: capture.liveTailBytes,
  traceEventCount: capture.traceEventCount,
  traceDataBytes: capture.traceDataBytes,
  outputPath,
}, null, 2));
