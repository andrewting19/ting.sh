import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPtydHttpBaseUrl, resolvePtydPort } from "../src/sidecarConfig";

const BASE_PORT = parseInt(process.env.PORT ?? "7681", 10);
const PTYD_PORT = resolvePtydPort(BASE_PORT);
const PTYD_HTTP_BASE_URL = getPtydHttpBaseUrl(BASE_PORT);
const LOG_DIR = join(tmpdir(), "ting-sh");
const LOG_PATH = join(LOG_DIR, `ptyd-${PTYD_PORT}.log`);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function isPtydHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${PTYD_HTTP_BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForPtyd(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPtydHealthy()) return;
    await Bun.sleep(50);
  }
  throw new Error(`ptyd failed to start on port ${PTYD_PORT}`);
}

async function main(): Promise<void> {
  if (await isPtydHealthy()) {
    console.log(`[dev-ptyd] already healthy on ${PTYD_HTTP_BASE_URL}`);
    return;
  }

  mkdirSync(LOG_DIR, { recursive: true });

  const envArgs = [
    `PORT=${shellQuote(String(BASE_PORT))}`,
    `PTYD_PORT=${shellQuote(String(PTYD_PORT))}`,
    `PTYD_IDLE_EXIT_MS=${shellQuote(process.env.PTYD_IDLE_EXIT_MS ?? "0")}`,
    `AUTO_UPDATE=${shellQuote(process.env.AUTO_UPDATE ?? "false")}`,
  ];
  if (process.env.HOSTS_FILE) envArgs.push(`HOSTS_FILE=${shellQuote(process.env.HOSTS_FILE)}`);
  if (process.env.SHELL) envArgs.push(`SHELL=${shellQuote(process.env.SHELL)}`);

  const cmd = `cd ${shellQuote(process.cwd())} && nohup env ${envArgs.join(" ")} ${shellQuote(process.execPath)} run ptyd.ts >> ${shellQuote(LOG_PATH)} 2>&1 < /dev/null &`;

  const launcher = Bun.spawn(["/bin/sh", "-lc", cmd], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await launcher.exited;
  await waitForPtyd();
  console.log(`[dev-ptyd] started on ${PTYD_HTTP_BASE_URL} (log: ${LOG_PATH})`);
}

await main();
