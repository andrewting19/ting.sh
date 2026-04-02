export interface CaptureSummary {
  sessionId: string;
  name: string;
  bufferBytes: number;
  xtermSnapshotBytes: number;
  renderedTextSnapshotBytes: number;
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
  snapshotBytes: number;
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
  return {
    sessionId: capture.id,
    name: capture.name,
    bufferBytes: capture.bufferBytes,
    xtermSnapshotBytes: capture.snapshotBytes,
    renderedTextSnapshotBytes: renderedTextBytes,
    rawToXtermRatio: safeRatio(capture.bufferBytes, capture.snapshotBytes),
    rawToRenderedTextRatio: safeRatio(capture.bufferBytes, renderedTextBytes),
    xtermToRenderedTextRatio: safeRatio(capture.snapshotBytes, renderedTextBytes),
    activeBuffer: capture.renderedTextSnapshot?.activeBuffer ?? "unknown",
    bufferTrimmed: capture.bufferTrimmed,
  };
}
