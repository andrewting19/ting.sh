import { expect, test } from "bun:test";
import { summarizeCapture } from "./captureAnalysis";

test("summarizeCapture computes raw vs snapshot ratios", () => {
  const summary = summarizeCapture({
    id: "session-1",
    name: "Test",
    bufferBytes: 10_000,
    bufferTrimmed: false,
    initialCols: 80,
    initialRows: 24,
    traceEventCount: 4,
    traceDataBytes: 9_500,
    traceEvents: [
      { type: "data", bytes: 100 },
      { type: "resize", cols: 100, rows: 30 },
      { type: "data", bytes: 200 },
      { type: "resize", cols: 90, rows: 28 },
    ],
    snapshotBytes: 2_000,
    snapshot: {
      cols: 90,
      rows: 28,
    },
    renderedTextSnapshotBytes: 500,
    renderedTextSnapshot: {
      activeBuffer: "normal",
    },
  });

  expect(summary.sessionId).toBe("session-1");
  expect(summary.bufferBytes).toBe(10_000);
  expect(summary.xtermSnapshotBytes).toBe(2_000);
  expect(summary.renderedTextSnapshotBytes).toBe(500);
  expect(summary.initialCols).toBe(80);
  expect(summary.initialRows).toBe(24);
  expect(summary.finalCols).toBe(90);
  expect(summary.finalRows).toBe(28);
  expect(summary.traceEventCount).toBe(4);
  expect(summary.traceDataEventCount).toBe(2);
  expect(summary.traceResizeCount).toBe(2);
  expect(summary.traceDataBytes).toBe(9_500);
  expect(summary.rawToXtermRatio).toBe(5);
  expect(summary.rawToRenderedTextRatio).toBe(20);
  expect(summary.xtermToRenderedTextRatio).toBe(4);
  expect(summary.activeBuffer).toBe("normal");
  expect(summary.bufferTrimmed).toBe(false);
});
