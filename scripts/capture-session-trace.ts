import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { getPtydHttpBaseUrl } from "../src/sidecarConfig";

interface DebugSessionCapture {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  outputSeq: number;
  snapshotSeq: number;
  bufferBytes: number;
  bufferTrimmed: boolean;
  liveTailBytes: number;
  liveTailSeq: number;
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

function usage(): never {
  console.error("usage: bun run scripts/capture-session-trace.ts <session-id> [output-path]");
  process.exit(1);
}

function getServerBaseUrl(): string {
  const host = process.env.SERVER_HOST?.trim() || "127.0.0.1";
  const port = parseInt(process.env.SERVER_PORT?.trim() || process.env.PORT?.trim() || "7681", 10);
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

const sessionId = process.argv[2];
if (!sessionId) usage();

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
  bufferBytes: capture.bufferBytes,
  snapshotBytes: capture.snapshotBytes,
  renderedTextSnapshotBytes: capture.renderedTextSnapshotBytes,
  activeBuffer: capture.renderedTextSnapshot.activeBuffer,
  liveTailBytes: capture.liveTailBytes,
  outputPath,
}, null, 2));
