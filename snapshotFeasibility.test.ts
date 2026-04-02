import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { XtermVtSnapshotTracker } from "./src/snapshot/xtermVtSnapshot";

interface BufferSnapshot {
  type: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  lines: string[];
}

interface TerminalSnapshotState {
  activeType: "normal" | "alternate";
  normal: BufferSnapshot;
  alternate: BufferSnapshot;
}

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, () => resolve()));
}

async function writeAll(term: Terminal, chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    await write(term, chunk);
  }
}

function snapshotBuffer(buffer: Terminal["buffer"]["active"]): BufferSnapshot {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return {
    type: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    lines,
  };
}

function snapshotTerminal(term: Terminal): TerminalSnapshotState {
  return {
    activeType: term.buffer.active.type,
    normal: snapshotBuffer(term.buffer.normal),
    alternate: snapshotBuffer(term.buffer.alternate),
  };
}

test("xterm headless serialize roundtrip preserves redraw-heavy normal buffer state", async () => {
  const source = new XtermVtSnapshotTracker(28, 6, 200);
  await writeAll(source.terminal, [
    "line-1\r\nline-2\r\nline-3\r\nline-4\r\nline-5\r\nline-6\r\nline-7\r\n",
    "\x1b[2J\x1b[H",
    "HEADER\r\n",
    "body-a\r\nbody-b\r\n",
    "\x1b[H",
    "HEAD",
    "\x1b[6;4Htail",
  ]);

  const snapshot = source.capture();
  const before = snapshotTerminal(source.terminal);

  const restored = new XtermVtSnapshotTracker(28, 6, 200);
  await restored.restore(snapshot);
  const after = snapshotTerminal(restored.terminal);

  expect(snapshot.payload.length).toBeGreaterThan(0);
  expect(after).toEqual(before);
});

test("xterm headless serialize roundtrip preserves alternate buffer and normal scrollback", async () => {
  const source = new XtermVtSnapshotTracker(32, 8, 200);
  await writeAll(source.terminal, [
    "normal-1\r\nnormal-2\r\nnormal-3\r\nnormal-4\r\nnormal-5\r\nnormal-6\r\nnormal-7\r\nnormal-8\r\nnormal-9\r\n",
    "\x1b[?1049h",
    "\x1b[2J\x1b[H",
    "ALT HEADER\r\n",
    "status: running",
    "\x1b[4;6Hcursor-here",
  ]);

  const snapshot = source.capture();
  const before = snapshotTerminal(source.terminal);

  const restored = new XtermVtSnapshotTracker(32, 8, 200);
  await restored.restore(snapshot);
  const after = snapshotTerminal(restored.terminal);

  expect(before.activeType).toBe("alternate");
  expect(after).toEqual(before);
  expect(after.normal.lines.some((line) => line.includes("normal-9"))).toBe(true);
  expect(after.alternate.lines.some((line) => line.includes("ALT HEADER"))).toBe(true);
});

test("serialized snapshot collapses redraw-heavy raw churn", async () => {
  const source = new XtermVtSnapshotTracker(40, 10, 500);
  let raw = "";
  for (let i = 0; i < 120; i += 1) {
    raw += "\x1b[2J\x1b[H";
    raw += `frame ${i}\r\n`;
    raw += `status: ${i % 7}\r\n`;
    raw += `spinner: ${["|", "/", "-", "\\"][i % 4]}\r\n`;
  }

  await source.write(raw);
  const snapshot = source.capture();

  expect(raw.length).toBeGreaterThan(0);
  expect(snapshot.payload.length).toBeGreaterThan(0);
  expect(snapshot.payload.length).toBeLessThan(raw.length / 3);
});
