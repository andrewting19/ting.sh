import type { Terminal } from "@xterm/headless";

export interface CanonicalSnapshotLine {
  text: string;
  wrapped: boolean;
}

export interface CanonicalSnapshotBuffer {
  type: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  lines: CanonicalSnapshotLine[];
}

export interface CanonicalTerminalSnapshot {
  format: "canonical-terminal-snapshot-v1";
  cols: number;
  rows: number;
  activeBuffer: "normal" | "alternate";
  normal: CanonicalSnapshotBuffer;
  alternate: CanonicalSnapshotBuffer;
  capturedAt: number;
}

function captureBuffer(buffer: Terminal["buffer"]["active"]): CanonicalSnapshotBuffer {
  const lines: CanonicalSnapshotLine[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    lines.push({
      text: line?.translateToString(true) ?? "",
      wrapped: line?.isWrapped ?? false,
    });
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

export function captureCanonicalTerminalSnapshot(term: Terminal): CanonicalTerminalSnapshot {
  return {
    format: "canonical-terminal-snapshot-v1",
    cols: term.cols,
    rows: term.rows,
    activeBuffer: term.buffer.active.type === "alternate" ? "alternate" : "normal",
    normal: captureBuffer(term.buffer.normal),
    alternate: captureBuffer(term.buffer.alternate),
    capturedAt: Date.now(),
  };
}
