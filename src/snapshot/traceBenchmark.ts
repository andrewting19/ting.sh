import { captureCanonicalTerminalSnapshot } from "./canonicalSnapshot";
import { captureRenderedTextSnapshot, renderedTextSnapshotToVt } from "./renderedTextSnapshot";
import { XtermVtSnapshotTracker } from "./xtermVtSnapshot";

export interface TraceBenchmarkInput {
  cols: number;
  rows: number;
  payload: Uint8Array | Buffer | string;
}

export interface TraceBenchmarkResult {
  rawBytes: number;
  xtermSnapshotBytes: number;
  renderedTextSnapshotBytes: number;
  activeBuffer: "normal" | "alternate";
  normalBaseY: number;
  alternateBaseY: number;
  rawToXtermRatio: number | null;
  rawToRenderedTextRatio: number | null;
  xtermToRenderedTextRatio: number | null;
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}

export async function benchmarkTrace(input: TraceBenchmarkInput): Promise<TraceBenchmarkResult> {
  const rawBytes = typeof input.payload === "string"
    ? Buffer.byteLength(input.payload)
    : Buffer.from(input.payload).length;
  const tracker = new XtermVtSnapshotTracker(input.cols, input.rows, 10_000);
  await tracker.write(input.payload);

  const xtermSnapshot = tracker.capture();
  const renderedTextSnapshot = captureRenderedTextSnapshot(tracker.terminal);
  const renderedTextVt = renderedTextSnapshotToVt(renderedTextSnapshot);
  const canonicalSnapshot = captureCanonicalTerminalSnapshot(tracker.terminal);

  return {
    rawBytes,
    xtermSnapshotBytes: xtermSnapshot.payload.length,
    renderedTextSnapshotBytes: renderedTextVt.length,
    activeBuffer: canonicalSnapshot.activeBuffer,
    normalBaseY: canonicalSnapshot.normal.baseY,
    alternateBaseY: canonicalSnapshot.alternate.baseY,
    rawToXtermRatio: safeRatio(rawBytes, xtermSnapshot.payload.length),
    rawToRenderedTextRatio: safeRatio(rawBytes, renderedTextVt.length),
    xtermToRenderedTextRatio: safeRatio(xtermSnapshot.payload.length, renderedTextVt.length),
  };
}
