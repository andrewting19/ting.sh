import { capturePtyTrace } from "../src/snapshot/ptyTraceCapture";
import { benchmarkTrace } from "../src/snapshot/traceBenchmark";

const kind = process.argv[2] ?? "redraw";

const scenarios: Record<string, { cols: number; rows: number; script: string }> = {
  redraw: {
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
  },
  alternate: {
    cols: 32,
    rows: 8,
    script: [
      "printf 'normal-1\\nnormal-2\\nnormal-3\\nnormal-4\\nnormal-5\\nnormal-6\\nnormal-7\\nnormal-8\\nnormal-9\\n';",
      "printf '\\033[?1049h\\033[2J\\033[H';",
      "printf 'ALT HEADER\\nstatus: running';",
      "printf '\\033[4;6Hcursor-here';",
    ].join(" "),
  },
  resize: {
    cols: 40,
    rows: 10,
    script: "",
  },
};

const scenario = scenarios[kind];
if (!scenario) {
  console.error(`unknown scenario "${kind}"`);
  console.error(`available: ${Object.keys(scenarios).join(", ")}`);
  process.exit(1);
}

const trace = await capturePtyTrace(
  kind === "resize"
    ? {
        ...scenario,
        steps: [
          { type: "write", data: "printf 'alpha\\nbeta\\ngamma\\n'\r", delayMs: 0 },
          { type: "resize", cols: 60, rows: 14, delayMs: 100 },
          { type: "write", data: "printf '\\033[2J\\033[Hwide-1\\nwide-2\\nwide-3\\nwide-4\\n'\r", delayMs: 100 },
          { type: "resize", cols: 32, rows: 8, delayMs: 100 },
          { type: "write", data: "printf '\\033[Hnarrow\\nfinal\\n'\r", delayMs: 100 },
          { type: "exit", delayMs: 100 },
        ],
        idleMs: 250,
        timeoutMs: 10_000,
      }
    : {
        ...scenario,
        idleMs: 250,
        timeoutMs: 10_000,
      },
);

const result = await benchmarkTrace({
  cols: trace.cols,
  rows: trace.rows,
  events: trace.events,
});

console.log(JSON.stringify({ scenario: kind, traceFinalCols: trace.finalCols, traceFinalRows: trace.finalRows, ...result }, null, 2));
