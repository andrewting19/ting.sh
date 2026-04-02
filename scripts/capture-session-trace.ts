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

const sessionId = process.argv[2];
if (!sessionId) usage();

const outputPath = resolve(process.argv[3] ?? `captures/session-${sessionId}-${Date.now()}.json`);
const ptydBaseUrl = getPtydHttpBaseUrl();
const res = await fetch(`${ptydBaseUrl}/debug/session?id=${encodeURIComponent(sessionId)}&includeRaw=1`);
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
