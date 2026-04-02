import type { Terminal } from "@xterm/headless";

export interface RenderedTextLine {
  text: string;
  wrapped: boolean;
}

export interface RenderedTextSnapshot {
  format: "rendered-text-snapshot-v1";
  cols: number;
  rows: number;
  activeBuffer: "normal" | "alternate";
  normalLines: RenderedTextLine[];
  alternateLines: RenderedTextLine[];
  cursorX: number;
  cursorY: number;
  capturedAt: number;
}

function captureBufferLines(buffer: Terminal["buffer"]["active"]): RenderedTextLine[] {
  const lines: RenderedTextLine[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    lines.push({
      text: line?.translateToString(true) ?? "",
      wrapped: line?.isWrapped ?? false,
    });
  }
  return lines;
}

export function captureRenderedTextSnapshot(term: Terminal): RenderedTextSnapshot {
  const activeBuffer = term.buffer.active.type === "alternate" ? "alternate" : "normal";
  const activeCursor = term.buffer.active;
  return {
    format: "rendered-text-snapshot-v1",
    cols: term.cols,
    rows: term.rows,
    activeBuffer,
    normalLines: captureBufferLines(term.buffer.normal),
    alternateLines: captureBufferLines(term.buffer.alternate),
    cursorX: activeCursor.cursorX,
    cursorY: activeCursor.cursorY,
    capturedAt: Date.now(),
  };
}

function logicalLines(lines: RenderedTextLine[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    current += line.text;
    if (line.wrapped) continue;
    out.push(current);
    current = "";
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

function escapeTextForVt(text: string): string {
  return text.replace(/\u001b/g, "");
}

export function renderedTextSnapshotToVt(snapshot: RenderedTextSnapshot): string {
  const parts: string[] = ["\x1b[0m\x1b[?25h"];
  const normalLines = logicalLines(snapshot.normalLines);
  normalLines.forEach((line, index) => {
    parts.push(escapeTextForVt(line));
    if (index < normalLines.length - 1) parts.push("\r\n");
  });

  if (snapshot.activeBuffer === "alternate") {
    parts.push("\x1b[?1049h\x1b[2J\x1b[H");
    const altLines = logicalLines(snapshot.alternateLines);
    altLines.slice(0, snapshot.rows).forEach((line, index) => {
      parts.push(`\x1b[${index + 1};1H${escapeTextForVt(line)}`);
    });
  }

  parts.push(`\x1b[${snapshot.cursorY + 1};${snapshot.cursorX + 1}H`);
  return parts.join("");
}
