import type { PtyTraceEvent } from "./ptyTraceCapture";
import { captureCanonicalTerminalSnapshot } from "./canonicalSnapshot";
import { captureRenderedTextSnapshot, renderedTextSnapshotToVt } from "./renderedTextSnapshot";
import { XtermVtSnapshotTracker } from "./xtermVtSnapshot";

export interface TraceBenchmarkInput {
  cols: number;
  rows: number;
  payload?: Uint8Array | Buffer | string;
  events?: PtyTraceEvent[];
}

export interface TraceBenchmarkResult {
  rawBytes: number;
  xtermSnapshotBytes: number;
  renderedTextSnapshotBytes: number;
  finalCols: number;
  finalRows: number;
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
  const tracker = new XtermVtSnapshotTracker(input.cols, input.rows, 10_000);
  let rawBytes = 0;

  if (input.events && input.events.length > 0) {
    for (const event of input.events) {
      if (event.type === "data") {
        rawBytes += Buffer.from(event.data).length;
        await tracker.write(event.data);
        continue;
      }
      tracker.resize(event.cols, event.rows);
    }
  } else if (input.payload != null) {
    rawBytes = typeof input.payload === "string"
      ? Buffer.byteLength(input.payload)
      : Buffer.from(input.payload).length;
    await tracker.write(input.payload);
  } else {
    throw new Error("benchmarkTrace requires payload or events");
  }

  const xtermSnapshot = tracker.capture();
  const renderedTextSnapshot = captureRenderedTextSnapshot(tracker.terminal);
  const renderedTextVt = renderedTextSnapshotToVt(renderedTextSnapshot);
  const canonicalSnapshot = captureCanonicalTerminalSnapshot(tracker.terminal);

  return {
    rawBytes,
    xtermSnapshotBytes: xtermSnapshot.payload.length,
    renderedTextSnapshotBytes: renderedTextVt.length,
    finalCols: tracker.terminal.cols,
    finalRows: tracker.terminal.rows,
    activeBuffer: canonicalSnapshot.activeBuffer,
    normalBaseY: canonicalSnapshot.normal.baseY,
    alternateBaseY: canonicalSnapshot.alternate.baseY,
    rawToXtermRatio: safeRatio(rawBytes, xtermSnapshot.payload.length),
    rawToRenderedTextRatio: safeRatio(rawBytes, renderedTextVt.length),
    xtermToRenderedTextRatio: safeRatio(xtermSnapshot.payload.length, renderedTextVt.length),
  };
}
