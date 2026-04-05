import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { getPtydHttpBaseUrl, getPtydWsUrl, resolvePtydPort } from "./src/sidecarConfig";
import { PTYD_PROTOCOL_VERSION, isPtydProtocolCompatible, parsePtydProtocolVersion } from "./src/sidecarProtocol";

const PORT = parseInt(process.env.PORT ?? "7681", 10);
const PTYD_PORT = resolvePtydPort(PORT);
const PTYD_HTTP_BASE_URL = getPtydHttpBaseUrl(PORT);
const PTYD_WS_URL = getPtydWsUrl(PORT);
const PTYD_AUTOSPAWN = (process.env.PTYD_AUTOSPAWN ?? "true") !== "false";

interface WSData {
  backend: WebSocket | null;
  queue: string[];
  closed: boolean;
}

interface HostInfo {
  id: string;
  name: string;
}

interface HostPeer extends HostInfo {
  url: string;
}

interface HostConfig {
  self: HostInfo;
  peers: HostPeer[];
}

interface RawHostsConfig {
  id?: unknown;
  name?: unknown;
  peers?: unknown;
}

interface RawHostPeer {
  id?: unknown;
  name?: unknown;
  url?: unknown;
}

function parseHostId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  const id = value.trim();
  if (id.includes(":")) throw new Error(`${field} cannot contain ":"`);
  return id;
}

function parseHostName(value: unknown, fallback: string, field: string): string {
  if (value == null) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function parseHostUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http:// or https://`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function isAllowedWsOrigin(req: Request, trustedPeerHostnames: Set<string>): boolean {
  const originHeader = req.headers.get("origin");
  if (!originHeader) return true;
  let origin: URL;
  let target: URL;
  try {
    origin = new URL(originHeader);
    target = new URL(req.url);
  } catch {
    return false;
  }
  if (origin.origin === target.origin) return true;
  if (trustedPeerHostnames.has(origin.hostname)) return true;
  if (origin.hostname === "localhost" || origin.hostname === "127.0.0.1") return true;
  return false;
}

function loadHostConfig(): HostConfig {
  const defaultHost = hostname();
  const defaults: HostConfig = { self: { id: defaultHost, name: defaultHost }, peers: [] };
  const configPath = process.env.HOSTS_FILE ?? "./hosts.json";
  if (configPath === "none" || !existsSync(configPath)) return defaults;

  let raw: RawHostsConfig;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8")) as RawHostsConfig;
  } catch (err) {
    throw new Error(`Failed to parse hosts.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const selfId = parseHostId(raw.id, "hosts.json id");
  const selfName = parseHostName(raw.name, selfId, "hosts.json name");
  const seen = new Set<string>([selfId]);
  const peersRaw = raw.peers ?? [];
  if (!Array.isArray(peersRaw)) throw new Error("hosts.json peers must be an array");

  const peers: HostPeer[] = peersRaw.map((peerRaw, idx) => {
    const peer = peerRaw as RawHostPeer;
    const id = parseHostId(peer.id, `hosts.json peers[${idx}].id`);
    if (seen.has(id)) throw new Error(`hosts.json contains duplicate host id "${id}"`);
    seen.add(id);
    const name = parseHostName(peer.name, id, `hosts.json peers[${idx}].name`);
    const url = parseHostUrl(peer.url, `hosts.json peers[${idx}].url`);
    return { id, name, url };
  });

  return { self: { id: selfId, name: selfName }, peers };
}

let HOST_CONFIG = loadHostConfig();
let TRUSTED_PEER_HOSTNAMES = new Set(HOST_CONFIG.peers.map((peer) => new URL(peer.url).hostname));

const hostsConfigPath = process.env.HOSTS_FILE ?? "./hosts.json";
if (hostsConfigPath !== "none" && existsSync(hostsConfigPath)) {
  const { watch } = await import("fs");
  let debounce: ReturnType<typeof setTimeout> | null = null;
  watch(hostsConfigPath, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const updated = loadHostConfig();
        HOST_CONFIG = updated;
        TRUSTED_PEER_HOSTNAMES = new Set(updated.peers.map((peer) => new URL(peer.url).hostname));
        console.log(`[hosts] reloaded hosts.json (${updated.peers.length} peers)`);
      } catch (err) {
        console.error(`[hosts] failed to reload hosts.json:`, err instanceof Error ? err.message : err);
      }
    }, 200);
  });
}

const g = globalThis as typeof globalThis & {
  __wt_ptyd_ready?: Promise<void> | null;
};

async function isPtydHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${PTYD_HTTP_BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchPtydHealth(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${PTYD_HTTP_BASE_URL}/health`);
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function waitForPtydDown(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPtydHealthy())) return;
    await Bun.sleep(50);
  }
  throw new Error(`ptyd did not stop within ${timeoutMs}ms`);
}

async function ensurePtyd(allowSpawn = PTYD_AUTOSPAWN): Promise<void> {
  if (await isPtydHealthy()) return;
  if (!allowSpawn) throw new Error(`ptyd unavailable on port ${PTYD_PORT}`);
  if (!g.__wt_ptyd_ready) {
    g.__wt_ptyd_ready = (async () => {
      if (await isPtydHealthy()) return;
      Bun.spawn([process.execPath, "run", "ptyd.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(PORT),
          PTYD_PORT: String(PTYD_PORT),
          PTYD_IDLE_EXIT_MS: process.env.PTYD_IDLE_EXIT_MS ?? "2000",
        },
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await isPtydHealthy()) return;
        await Bun.sleep(50);
      }
      throw new Error(`ptyd failed to start on port ${PTYD_PORT}`);
    })().finally(() => {
      g.__wt_ptyd_ready = null;
    });
  }
  return g.__wt_ptyd_ready;
}

async function restartPtyd(): Promise<void> {
  const health = await fetchPtydHealth();
  const pid = typeof health?.pid === "number" && Number.isInteger(health.pid) ? health.pid : null;
  if (pid !== null) {
    try {
      process.kill(pid);
    } catch {
      // already exited
    }
    await waitForPtydDown();
  }
  await ensurePtyd(true);
}

function connectBackendProxy(ws: ServerWebSocket<WSData>) {
  const backend = new WebSocket(PTYD_WS_URL);
  backend.binaryType = "arraybuffer";
  ws.data.backend = backend;

  backend.onopen = () => {
    if (ws.data.closed) {
      backend.close();
      return;
    }
    for (const payload of ws.data.queue.splice(0, ws.data.queue.length)) backend.send(payload);
  };

  backend.onmessage = (event) => {
    if (ws.data.closed) return;
    try {
      if (event.data instanceof ArrayBuffer) {
        ws.sendBinary(new Uint8Array(event.data));
        return;
      }
      ws.send(String(event.data));
    } catch {
      ws.close();
    }
  };

  backend.onclose = () => {
    ws.data.backend = null;
    if (!ws.data.closed) ws.close();
  };

  backend.onerror = () => {
    if (!ws.data.closed) ws.close();
  };
}

try {
  await ensurePtyd();
} catch (err) {
  if (PTYD_AUTOSPAWN) throw err;
  console.warn(`[ptyd] startup skipped: ${err instanceof Error ? err.message : String(err)}`);
}

const server = Bun.serve<WSData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (!isAllowedWsOrigin(req, TRUSTED_PEER_HOSTNAMES)) return new Response("Forbidden", { status: 403 });
      try {
        await ensurePtyd();
      } catch {
        return new Response("Sidecar unavailable", { status: 503 });
      }
      if (server.upgrade(req, { data: { backend: null, queue: [], closed: false } })) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    if (url.pathname === "/api/version") return Response.json({ version: getCurrentVersion() ?? "dev" });
    if (url.pathname === "/api/host") {
      return Response.json({ self: HOST_CONFIG.self, peers: HOST_CONFIG.peers });
    }
    if (url.pathname === "/api/sidecar") {
      try {
        await ensurePtyd();
        const health = await fetchPtydHealth();
        if (!health) throw new Error("Sidecar unavailable");
        const protocolVersion = parsePtydProtocolVersion(health.protocolVersion);
        return Response.json({
          baseUrl: PTYD_HTTP_BASE_URL,
          wsUrl: PTYD_WS_URL,
          port: PTYD_PORT,
          expectedProtocolVersion: PTYD_PROTOCOL_VERSION,
          protocolCompatible: isPtydProtocolCompatible(protocolVersion),
          health: {
            ...health,
            protocolVersion,
          },
        });
      } catch {
        return Response.json({
          baseUrl: PTYD_HTTP_BASE_URL,
          wsUrl: PTYD_WS_URL,
          port: PTYD_PORT,
          expectedProtocolVersion: PTYD_PROTOCOL_VERSION,
          protocolCompatible: false,
          health: null,
        }, { status: 502 });
      }
    }
    if (url.pathname === "/api/sidecar/restart") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        await restartPtyd();
        const health = await fetchPtydHealth();
        const protocolVersion = parsePtydProtocolVersion(health?.protocolVersion);
        return Response.json({
          ok: true,
          baseUrl: PTYD_HTTP_BASE_URL,
          wsUrl: PTYD_WS_URL,
          port: PTYD_PORT,
          expectedProtocolVersion: PTYD_PROTOCOL_VERSION,
          protocolCompatible: isPtydProtocolCompatible(protocolVersion),
          health: health ? { ...health, protocolVersion } : null,
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }, { status: 502 });
      }
    }
    if (url.pathname === "/api/debug/session") {
      try {
        await ensurePtyd();
      } catch {
        return Response.json({ error: "Sidecar unavailable" }, { status: 502 });
      }
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
      const includeRaw = url.searchParams.get("includeRaw");
      const targetUrl = new URL(`${PTYD_HTTP_BASE_URL}/debug/session`);
      targetUrl.searchParams.set("id", id);
      if (includeRaw) targetUrl.searchParams.set("includeRaw", includeRaw);
      try {
        const res = await fetch(targetUrl);
        const payload = await res.text();
        return new Response(payload, {
          status: res.status,
          headers: {
            "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8",
          },
        });
      } catch {
        return Response.json({ error: "Sidecar unavailable" }, { status: 502 });
      }
    }

    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`./dist${filePath}`);
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      ws.send(JSON.stringify({
        type: "host-info",
        id: HOST_CONFIG.self.id,
        name: HOST_CONFIG.self.name,
      }));
      connectBackendProxy(ws);
    },

    message(ws, msg) {
      if (typeof msg !== "string") return;
      const backend = ws.data.backend;
      if (backend?.readyState === WebSocket.OPEN) {
        backend.send(msg);
        return;
      }
      ws.data.queue.push(msg);
    },

    close(ws) {
      ws.data.closed = true;
      ws.data.backend?.close();
      ws.data.backend = null;
      ws.data.queue = [];
    },
  },
});

console.log(`ting.sh listening on http://localhost:${server.port}`);

const AUTO_UPDATE_REPO = process.env.AUTO_UPDATE_REPO ?? "andrewting19/ting.sh";
const AUTO_UPDATE_INTERVAL = parseInt(process.env.AUTO_UPDATE_INTERVAL ?? String(5 * 60_000), 10);
const AUTO_UPDATE_ENABLED = (process.env.AUTO_UPDATE ?? "true") !== "false";

function getCurrentVersion(): string | null {
  try {
    return readFileSync("./VERSION", "utf-8").trim();
  } catch {
    return null;
  }
}

async function checkForUpdate(): Promise<void> {
  const current = getCurrentVersion();
  if (!current) return;
  const isWindows = process.platform === "win32";

  try {
    const res = await fetch(`https://api.github.com/repos/${AUTO_UPDATE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const data = await res.json() as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> };
    const tag = data.tag_name;
    if (!tag) return;
    const latest = tag.replace(/^v/, "");
    if (latest === current) return;
    console.log(`[auto-update] new version available: v${latest} (current: v${current})`);
    const asset = data.assets?.find((entry) => isWindows ? entry.name.endsWith(".zip") : entry.name.endsWith(".tar.gz"));
    if (!asset) return;

    const releaseRes = await fetch(asset.browser_download_url);
    if (!releaseRes.ok || !releaseRes.body) return;
    const ext = isWindows ? ".zip" : ".tar.gz";
    const tmpPath = join(".", `.update-${latest}${ext}`);
    writeFileSync(tmpPath, new Uint8Array(await releaseRes.arrayBuffer()));
    const extract = isWindows
      ? Bun.spawn(["powershell", "-NoProfile", "-Command", `Expand-Archive -Path '${tmpPath}' -DestinationPath '.' -Force`], { stdout: "pipe", stderr: "pipe" })
      : Bun.spawn(["tar", "xzf", tmpPath, "-C", "."], { stdout: "pipe", stderr: "pipe" });
    await extract.exited;
    if (extract.exitCode !== 0) {
      try { unlinkSync(tmpPath); } catch {}
      return;
    }
    try { unlinkSync(tmpPath); } catch {}

    const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await install.exited;
    if (install.exitCode !== 0) return;
    console.log(`[auto-update] updated to v${latest}, restarting...`);
    process.exit(0);
  } catch (err) {
    console.log(`[auto-update] check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (AUTO_UPDATE_ENABLED) {
  setTimeout(checkForUpdate, 10_000);
  setInterval(checkForUpdate, AUTO_UPDATE_INTERVAL);
  console.log(`[auto-update] enabled, checking ${AUTO_UPDATE_REPO} every ${AUTO_UPDATE_INTERVAL / 60_000}min`);
} else {
  console.log("[auto-update] disabled");
}
