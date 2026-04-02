import { expect, test } from "bun:test";
import { capturePtyTrace } from "./ptyTraceCapture";
import { benchmarkTrace } from "./traceBenchmark";

test("benchmarkTrace shows redraw-heavy churn collapsing under snapshots", async () => {
  const trace = await capturePtyTrace({
    cols: 40,
    rows: 10,
    script: [
      "for i in $(seq 1 80); do",
      "  printf '\\033[2J\\033[H';",
      "  printf 'frame %s\\n' \"$i\";",
      "  printf 'status %s\\n' \"$((i % 7))\";",
      "  printf 'spinner %s\\n' \"$(printf '%s' '|/-\\\\' | cut -c $(( (i % 4) + 1 )))\";",
      "done",
    ].join(" "),
    idleMs: 250,
    timeoutMs: 10_000,
  });

  const result = await benchmarkTrace({
    cols: trace.cols,
    rows: trace.rows,
    payload: trace.combined,
  });

  expect(result.rawBytes).toBeGreaterThan(0);
  expect(result.xtermSnapshotBytes).toBeGreaterThan(0);
  expect(result.renderedTextSnapshotBytes).toBeGreaterThan(0);
  expect(result.rawToXtermRatio).not.toBeNull();
  expect(result.rawToRenderedTextRatio).not.toBeNull();
  expect(result.rawToXtermRatio!).toBeGreaterThan(2);
  expect(result.rawToRenderedTextRatio!).toBeGreaterThan(4);
  expect(result.activeBuffer).toBe("normal");
});

test("benchmarkTrace records alternate-buffer sessions separately", async () => {
  const trace = await capturePtyTrace({
    cols: 32,
    rows: 8,
    script: [
      "printf 'normal-1\\nnormal-2\\nnormal-3\\nnormal-4\\nnormal-5\\nnormal-6\\nnormal-7\\nnormal-8\\nnormal-9\\n';",
      "printf '\\033[?1049h\\033[2J\\033[H';",
      "printf 'ALT HEADER\\nstatus: running';",
      "printf '\\033[4;6Hcursor-here';",
    ].join(" "),
    idleMs: 250,
    timeoutMs: 10_000,
  });

  const result = await benchmarkTrace({
    cols: trace.cols,
    rows: trace.rows,
    payload: trace.combined,
  });

  expect(result.activeBuffer).toBe("alternate");
  expect(result.normalBaseY).toBeGreaterThan(0);
  expect(result.xtermSnapshotBytes).toBeGreaterThan(0);
  expect(result.renderedTextSnapshotBytes).toBeGreaterThan(0);
});

test("benchmarkTrace tracks explicit resize-heavy traces", async () => {
  const trace = await capturePtyTrace({
    cols: 40,
    rows: 10,
    script: "",
    steps: [
      { type: "write", data: "printf 'alpha\\nbeta\\ngamma\\n'\r", delayMs: 0 },
      { type: "resize", cols: 60, rows: 14, delayMs: 100 },
      { type: "write", data: "printf '\\033[2J\\033[Hwide-1\\nwide-2\\nwide-3\\n'\r", delayMs: 100 },
      { type: "resize", cols: 32, rows: 8, delayMs: 100 },
      { type: "write", data: "printf '\\033[Hnarrow\\nfinal\\n'\r", delayMs: 100 },
      { type: "exit", delayMs: 100 },
    ],
    idleMs: 250,
    timeoutMs: 10_000,
  });

  const result = await benchmarkTrace({
    cols: trace.cols,
    rows: trace.rows,
    events: trace.events,
  });

  expect(result.rawBytes).toBeGreaterThan(0);
  expect(result.finalCols).toBe(32);
  expect(result.finalRows).toBe(8);
  expect(result.activeBuffer).toBe("normal");
  expect(result.xtermSnapshotBytes).toBeGreaterThan(0);
  expect(result.renderedTextSnapshotBytes).toBeGreaterThan(0);
  expect(result.rawToXtermRatio).not.toBeNull();
});
