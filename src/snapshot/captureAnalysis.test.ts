import { expect, test } from "bun:test";
import { summarizeCapture } from "./captureAnalysis";

test("summarizeCapture computes raw vs snapshot ratios", () => {
  const summary = summarizeCapture({
    id: "session-1",
    name: "Test",
    bufferBytes: 10_000,
    bufferTrimmed: false,
    snapshotBytes: 2_000,
    renderedTextSnapshotBytes: 500,
    renderedTextSnapshot: {
      activeBuffer: "normal",
    },
  });

  expect(summary.sessionId).toBe("session-1");
  expect(summary.bufferBytes).toBe(10_000);
  expect(summary.xtermSnapshotBytes).toBe(2_000);
  expect(summary.renderedTextSnapshotBytes).toBe(500);
  expect(summary.rawToXtermRatio).toBe(5);
  expect(summary.rawToRenderedTextRatio).toBe(20);
  expect(summary.xtermToRenderedTextRatio).toBe(4);
  expect(summary.activeBuffer).toBe("normal");
  expect(summary.bufferTrimmed).toBe(false);
});
