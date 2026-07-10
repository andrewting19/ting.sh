import { readFileSync } from "fs";
import { getPtydHttpBaseUrl, resolvePtydPort } from "../src/sidecarConfig";
import { resolveServerPort } from "../src/serverPort";
import { ptydLogPath, spawnPtydDetached } from "../src/ptydSpawn";

const BASE_PORT = resolveServerPort();
const PTYD_PORT = resolvePtydPort(BASE_PORT);
const PTYD_HTTP_BASE_URL = getPtydHttpBaseUrl(BASE_PORT);
const LOG_PATH = ptydLogPath(PTYD_PORT);

type PtydProbe =
  | { state: "healthy" }
  | { state: "unhealthy"; status: number }
  | { state: "down" };

async function probePtyd(): Promise<PtydProbe> {
  try {
    const res = await fetch(`${PTYD_HTTP_BASE_URL}/health`);
    if (res.ok) return { state: "healthy" };
    return { state: "unhealthy", status: res.status };
  } catch {
    return { state: "down" };
  }
}

function logTail(lines = 20): string | null {
  try {
    const content = readFileSync(LOG_PATH, "utf8").trimEnd();
    if (!content) return null;
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return null;
  }
}

async function listeningPid(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-tiTCP:${PTYD_PORT}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return text.split("\n")[0] || null;
  } catch {
    return null;
  }
}

// The first launchd boot on macOS can block on a TCC prompt ("bun would like
// to access files in your Documents folder") — give the user time to answer.
async function waitForPtyd(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probePtyd()).state === "healthy") return;
    await Bun.sleep(50);
  }
  const tail = logTail();
  throw new Error(
    `ptyd failed to become healthy on port ${PTYD_PORT} within ${timeoutMs}ms` +
    (tail ? `\n--- ${LOG_PATH} (tail) ---\n${tail}` : ""),
  );
}

async function main(): Promise<void> {
  const probe = await probePtyd();
  if (probe.state === "healthy") {
    console.log(`[dev-ptyd] already healthy on ${PTYD_HTTP_BASE_URL}`);
    return;
  }

  if (probe.state === "unhealthy") {
    const pid = await listeningPid();
    const tail = logTail();
    console.error(
      `[dev-ptyd] a ptyd is already listening on port ${PTYD_PORT}${pid ? ` (pid ${pid})` : ""} ` +
      `but /health returned ${probe.status} — refusing to spawn a replacement into an occupied port.`,
    );
    if (tail) console.error(`--- ${LOG_PATH} (tail) ---\n${tail}`);
    if (tail?.includes("EPERM")) {
      console.error(
        "[dev-ptyd] EPERM reading repo files usually means macOS TCC revoked the daemon's " +
        "~/Documents access (often after its responsible app auto-updated). Toggle that app's " +
        "access off and on under System Settings → Privacy & Security → Full Disk Access " +
        "(or Files & Folders) to heal the running daemon without losing sessions.",
      );
    }
    console.error(
      `[dev-ptyd] Alternatively, kill the daemon to abandon its sessions and re-run: kill ${pid ?? "<pid>"}`,
    );
    process.exit(1);
  }

  const env: Record<string, string> = {
    TING_PORT: String(BASE_PORT),
    PTYD_PORT: String(PTYD_PORT),
    PTYD_IDLE_EXIT_MS: process.env.PTYD_IDLE_EXIT_MS ?? "0",
    AUTO_UPDATE: process.env.AUTO_UPDATE ?? "false",
  };
  if (process.env.HOSTS_FILE) env.HOSTS_FILE = process.env.HOSTS_FILE;
  if (process.env.SHELL) env.SHELL = process.env.SHELL;

  const mode = await spawnPtydDetached({
    cwd: process.cwd(),
    ptydPort: PTYD_PORT,
    logPath: LOG_PATH,
    env,
  });
  await waitForPtyd();
  console.log(`[dev-ptyd] started via ${mode} on ${PTYD_HTTP_BASE_URL} (log: ${LOG_PATH})`);
}

await main();
