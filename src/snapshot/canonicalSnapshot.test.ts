import { expect, test } from "bun:test";
import { XtermVtSnapshotTracker } from "./xtermVtSnapshot";
import { captureCanonicalTerminalSnapshot } from "./canonicalSnapshot";

test("canonical terminal snapshot captures normal and alternate buffer state", async () => {
  const tracker = new XtermVtSnapshotTracker(20, 6, 200);
  await tracker.write("normal-1\r\nnormal-2\r\nnormal-3\r\nnormal-4\r\nnormal-5\r\nnormal-6\r\nnormal-7\r\n");
  await tracker.write("\x1b[?1049h");
  await tracker.write("\x1b[2J\x1b[H");
  await tracker.write("ALT HEADER\r\n");
  await tracker.write("status: running");
  await tracker.write("\x1b[4;6Hcursor-here");

  const snapshot = captureCanonicalTerminalSnapshot(tracker.terminal);
  expect(snapshot.format).toBe("canonical-terminal-snapshot-v1");
  expect(snapshot.cols).toBe(20);
  expect(snapshot.rows).toBe(6);
  expect(snapshot.activeBuffer).toBe("alternate");

  expect(snapshot.normal.baseY).toBeGreaterThan(0);
  expect(snapshot.normal.lines.some((line) => line.text.includes("normal-7"))).toBe(true);

  expect(snapshot.alternate.type).toBe("alternate");
  expect(snapshot.alternate.lines.some((line) => line.text.includes("ALT HEADER"))).toBe(true);
  expect(snapshot.alternate.lines.some((line) => line.text.includes("status: running"))).toBe(true);
  expect(snapshot.alternate.lines.some((line) => line.text.includes("cursor-here"))).toBe(true);
  expect(snapshot.alternate.cursorX).toBeGreaterThanOrEqual(0);
  expect(snapshot.alternate.cursorY).toBeGreaterThanOrEqual(0);
});
