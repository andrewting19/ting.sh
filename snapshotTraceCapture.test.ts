import { expect, test } from "bun:test";
import { capturePtyTrace } from "./src/snapshot/ptyTraceCapture";
import { XtermVtSnapshotTracker } from "./src/snapshot/xtermVtSnapshot";

function snapshotLines(term: XtermVtSnapshotTracker): string[] {
  const lines: string[] = [];
  for (let i = 0; i < term.terminal.buffer.active.length; i += 1) {
    lines.push(term.terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
  }
  return lines;
}

test("captured PTY traces can be replayed into the headless snapshot tracker", async () => {
  const trace = await capturePtyTrace({
    cols: 40,
    rows: 10,
    script: [
      "printf 'trace-1\\ntrace-2\\ntrace-3\\n'",
      "printf '\\033[2J\\033[HHEADER\\nbody-a\\nbody-b\\n'",
      "printf '\\033[HHEAD'",
      "printf '\\033[5;8Htail'",
    ].join("; "),
  });

  const source = new XtermVtSnapshotTracker(trace.cols, trace.rows, 200);
  await source.write(trace.combined);
  const snapshot = source.capture();

  const restored = new XtermVtSnapshotTracker(trace.cols, trace.rows, 200);
  await restored.restore(snapshot);

  expect(snapshot.payload.length).toBeGreaterThan(0);
  expect(snapshotLines(restored)).toEqual(snapshotLines(source));
  expect(snapshotLines(restored).some((line) => line.includes("HEAD"))).toBe(true);
  expect(snapshotLines(restored).some((line) => line.includes("tail"))).toBe(true);
});
