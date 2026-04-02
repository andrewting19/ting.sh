export interface CaptureSummary {
  sessionId: string;
  name: string;
  bufferBytes: number;
  xtermSnapshotBytes: number;
  renderedTextSnapshotBytes: number;
  initialCols: number | null;
  initialRows: number | null;
  finalCols: number | null;
  finalRows: number | null;
  traceEventCount: number;
  traceDataEventCount: number;
  traceResizeCount: number;
  traceDataBytes: number;
  rawToXtermRatio: number | null;
  rawToRenderedTextRatio: number | null;
  xtermToRenderedTextRatio: number | null;
  activeBuffer: string;
  bufferTrimmed: boolean;
}

interface CaptureLike {
  id: string;
  name: string;
  bufferBytes: number;
  bufferTrimmed: boolean;
  initialCols?: number;
  initialRows?: number;
  traceEventCount?: number;
  traceDataBytes?: number;
  traceEvents?: Array<
    | { type?: "data"; base64?: string; bytes?: number }
    | { type?: "resize"; cols?: number; rows?: number }
  >;
  snapshotBytes: number;
  snapshot?: {
    cols?: number;
    rows?: number;
  };
  renderedTextSnapshotBytes?: number;
  renderedTextSnapshot?: {
    activeBuffer?: string;
  };
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}

export function summarizeCapture(capture: CaptureLike): CaptureSummary {
  const renderedTextBytes = Math.max(0, capture.renderedTextSnapshotBytes ?? 0);
  const traceEvents = Array.isArray(capture.traceEvents) ? capture.traceEvents : [];
  const traceDataEventCount = traceEvents.filter((event) => event.type === "data").length;
  const traceResizeCount = traceEvents.filter((event) => event.type === "resize").length;
  return {
    sessionId: capture.id,
    name: capture.name,
    bufferBytes: capture.bufferBytes,
    xtermSnapshotBytes: capture.snapshotBytes,
    renderedTextSnapshotBytes: renderedTextBytes,
    initialCols: typeof capture.initialCols === "number" ? capture.initialCols : null,
    initialRows: typeof capture.initialRows === "number" ? capture.initialRows : null,
    finalCols: typeof capture.snapshot?.cols === "number" ? capture.snapshot.cols : null,
    finalRows: typeof capture.snapshot?.rows === "number" ? capture.snapshot.rows : null,
    traceEventCount: typeof capture.traceEventCount === "number" ? capture.traceEventCount : traceEvents.length,
    traceDataEventCount,
    traceResizeCount,
    traceDataBytes: typeof capture.traceDataBytes === "number" ? capture.traceDataBytes : 0,
    rawToXtermRatio: safeRatio(capture.bufferBytes, capture.snapshotBytes),
    rawToRenderedTextRatio: safeRatio(capture.bufferBytes, renderedTextBytes),
    xtermToRenderedTextRatio: safeRatio(capture.snapshotBytes, renderedTextBytes),
    activeBuffer: capture.renderedTextSnapshot?.activeBuffer ?? "unknown",
    bufferTrimmed: capture.bufferTrimmed,
  };
}
