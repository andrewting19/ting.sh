import { readFileSync } from "fs";
import { resolve } from "path";
import { summarizeCapture } from "../src/snapshot/captureAnalysis";

function usage(): never {
  console.error("usage: bun run scripts/analyze-session-capture.ts <capture-json>");
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) usage();

const raw = readFileSync(resolve(inputPath), "utf8");
const capture = JSON.parse(raw) as Parameters<typeof summarizeCapture>[0];
const summary = summarizeCapture(capture);

console.log(JSON.stringify(summary, null, 2));
