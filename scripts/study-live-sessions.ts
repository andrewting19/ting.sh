import { mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { summarizeCapture } from "../src/snapshot/captureAnalysis";

interface CaptureBatchResult {
  sessionCount: number;
  outputDir: string;
  results: Array<{
    sessionId: string;
    name: string;
    outputPath?: string;
    error?: string;
  }>;
}

interface MeasureBatchResult {
  renderer: string;
  sessionCount: number;
  results: Array<{
    sessionId: string;
    sessionName: string;
    raw: { durationMs: number | null; replayBytesExpected: number | null; replayBytesReceived: number };
    snapshot: { durationMs: number | null; backend: string | null; snapshotBytes: number | null };
  }>;
}

function usage(): never {
  console.error("usage: bun run scripts/study-live-sessions.ts [renderer] [output-dir]");
  process.exit(1);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function runJsonScript(args: string[]): Promise<unknown> {
  const proc = Bun.spawn([process.execPath, "run", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return JSON.parse(stdout);
}

const renderer = process.argv[2] ?? "xterm";
if (renderer.startsWith("-")) usage();
const outputDir = resolve(process.argv[3] ?? `captures/study-${Date.now()}`);
mkdirSync(outputDir, { recursive: true });

const capture = await runJsonScript(["scripts/capture-session-trace.ts", "--all", outputDir]) as CaptureBatchResult;
const measure = await runJsonScript(["scripts/measure-session-reconnect.ts", "--all", renderer]) as MeasureBatchResult;

const rows = capture.results.map((entry) => {
  const measurement = measure.results.find((result) => result.sessionId === entry.sessionId);
  const captureSummary = entry.outputPath ? summarizeCapture(readJsonFile(entry.outputPath)) : null;
  return {
    sessionId: entry.sessionId,
    name: entry.name,
    capturePath: entry.outputPath ?? null,
    captureError: entry.error ?? null,
    captureSummary,
    measurement: measurement ?? null,
  };
});

const report = {
  renderer,
  outputDir,
  sessionCount: capture.sessionCount,
  rows,
};

const reportPath = resolve(outputDir, `study-${renderer}.json`);
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
