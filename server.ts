import { randomUUID } from "crypto";
import { existsSync, readFileSync, readlinkSync, unlinkSync, writeFileSync, mkdirSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { sanitizeReplayBuffer } from "./serverBuffer";
import { defaultCwd, defaultShell, prepareEnvForShell, spawnPty, type PtyProcess } from "./src/pty";
import { isGitBashShell, stripWindowsCwdControlFrames } from "./src/windowsShellIntegration";

const PORT = parseInt(process.env.PORT ?? "7681");
const MAX_BUFFER = parseInt(process.env.MAX_BUFFER_BYTES ?? String(10 * 1024 * 1024)); // 10MB by default

interface Session {
  id: string;
  name: string;
  proc: PtyProcess | null;
  shell: string;
  buffer: Buffer;
  bufferTrimmed: boolean;
  clients: Set<ServerWebSocket<WSData>>;
  createdAt: number;
  cwd: string;
  cwdTimer: ReturnType<typeof setTimeout> | null;
  shellControlRemainder: string;
  shellTracksCwd: boolean;
}

interface WSData {
  sessionId: string | null;
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

type ParsedClientMessage = { type: string } & Record<string, unknown>;

function parseHostId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const id = value.trim();
  if (id.includes(":")) {
    throw new Error(`${field} cannot contain ":"`);
  }
  return id;
}

function parseHostName(value: unknown, fallback: string, field: string): string {
  if (value == null) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseHostUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
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

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n > 0 ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isAllowedWsOrigin(req: Request, trustedPeerHostnames: Set<string>): boolean {
  const originHeader = req.headers.get("origin");
  // Allow non-browser clients (no Origin header).
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
  // Multi-host UI connects directly to peer /ws endpoints from the local page,
  // so allow origins whose hostname matches a configured peer (any port — dev
  // server and prod server may use different ports on the same machine).
  if (trustedPeerHostnames.has(origin.hostname)) return true;
  // Also trust localhost/loopback — the peer's browser always appears as
  // localhost when running locally, regardless of the Tailscale hostname.
  if (origin.hostname === "localhost" || origin.hostname === "127.0.0.1") return true;
  return false;
}

function loadHostConfig(): HostConfig {
  const defaultHost = hostname();
  const defaults: HostConfig = {
    self: { id: defaultHost, name: defaultHost },
    peers: [],
  };
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
  if (!Array.isArray(peersRaw)) {
    throw new Error("hosts.json peers must be an array");
  }

  const peers: HostPeer[] = peersRaw.map((peerRaw, idx) => {
    const peer = peerRaw as RawHostPeer;
    const id = parseHostId(peer.id, `hosts.json peers[${idx}].id`);
    if (seen.has(id)) {
      throw new Error(`hosts.json contains duplicate host id "${id}"`);
    }
    seen.add(id);
    const name = parseHostName(peer.name, id, `hosts.json peers[${idx}].name`);
    const url = parseHostUrl(peer.url, `hosts.json peers[${idx}].url`);
    return { id, name, url };
  });

  return {
    self: { id: selfId, name: selfName },
    peers,
  };
}

let HOST_CONFIG = loadHostConfig();
// Trust peer hostnames regardless of port — the peer UI may be served on a
// different port (e.g. Vite :4321 in dev) from the production server (:7681).
let TRUSTED_PEER_HOSTNAMES = new Set(HOST_CONFIG.peers.map((peer) => new URL(peer.url).hostname));

// Hot-reload hosts.json on change
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

// All 172 champions as of Feb 2026 (Zaahen is the most recent)
const CHAMPION_NAMES = [
  'Aatrox', 'Ahri', 'Akali', 'Akshan', 'Alistar', 'Ambessa', 'Amumu', 'Anivia', 'Annie', 'Aphelios', 'Ashe', 'Aurelion Sol', 'Aurora', 'Azir',
  'Bard', "Bel'Veth", 'Blitzcrank', 'Brand', 'Braum', 'Briar',
  'Caitlyn', 'Camille', 'Cassiopeia', "Cho'Gath", 'Corki',
  'Darius', 'Diana', 'Dr. Mundo', 'Draven',
  'Ekko', 'Elise', 'Evelynn', 'Ezreal',
  'Fiddlesticks', 'Fiora', 'Fizz',
  'Galio', 'Gangplank', 'Garen', 'Gnar', 'Gragas', 'Graves', 'Gwen',
  'Hecarim', 'Heimerdinger', 'Hwei',
  'Illaoi', 'Irelia', 'Ivern',
  'Janna', 'Jarvan IV', 'Jax', 'Jayce', 'Jhin', 'Jinx',
  "K'Sante", "Kai'Sa", 'Kalista', 'Karma', 'Karthus', 'Kassadin', 'Katarina', 'Kayle', 'Kayn', 'Kennen', "Kha'Zix", 'Kindred', 'Kled', "Kog'Maw",
  'LeBlanc', 'Lee Sin', 'Leona', 'Lillia', 'Lissandra', 'Lucian', 'Lulu', 'Lux',
  'Malphite', 'Malzahar', 'Maokai', 'Master Yi', 'Mel', 'Milio', 'Miss Fortune', 'Mordekaiser', 'Morgana',
  'Naafiri', 'Nami', 'Nasus', 'Nautilus', 'Neeko', 'Nidalee', 'Nilah', 'Nocturne', 'Nunu & Willump',
  'Olaf', 'Orianna', 'Ornn',
  'Pantheon', 'Poppy', 'Pyke',
  'Qiyana', 'Quinn',
  'Rakan', 'Rammus', "Rek'Sai", 'Rell', 'Renata Glasc', 'Renekton', 'Rengar', 'Riven', 'Rumble', 'Ryze',
  'Samira', 'Sejuani', 'Senna', 'Seraphine', 'Sett', 'Shaco', 'Shen', 'Shyvana', 'Singed', 'Sion', 'Sivir', 'Skarner', 'Smolder', 'Sona', 'Soraka', 'Swain', 'Sylas', 'Syndra',
  'Tahm Kench', 'Taliyah', 'Talon', 'Taric', 'Teemo', 'Thresh', 'Tristana', 'Trundle', 'Tryndamere', 'Twisted Fate', 'Twitch',
  'Udyr', 'Urgot',
  'Varus', 'Vayne', 'Veigar', "Vel'Koz", 'Vex', 'Vi', 'Viego', 'Viktor', 'Vladimir', 'Volibear',
  'Warwick', 'Wukong',
  'Xayah', 'Xerath', 'Xin Zhao',
  'Yasuo', 'Yone', 'Yorick', 'Yunara', 'Yuumi',
  'Zaahen', 'Zac', 'Zed', 'Zeri', 'Ziggs', 'Zilean', 'Zoe', 'Zyra',
];

function pickSessionName(): string {
  const used = new Set([...sessions.values()].map(s => s.name));
  const available = CHAMPION_NAMES.filter(n => !used.has(n));
  if (available.length > 0) return available[Math.floor(Math.random() * available.length)];
  return `session-${randomUUID().slice(0, 6)}`; // fallback if all ~120 names are taken
}

// Persist sessions across Bun --hot reloads (globalThis survives module re-evaluation)
const g = globalThis as typeof globalThis & {
  __wt_sessions?: Map<string, Session>;
  __wt_cwd_poll?: ReturnType<typeof setInterval>;
};
if (!g.__wt_sessions) g.__wt_sessions = new Map();
const sessions = g.__wt_sessions;
const listSubscribers = new Set<ServerWebSocket<WSData>>();

// Platform-aware CWD reader.
// Linux: single readlink syscall on /proc/<pid>/cwd — essentially free.
// macOS: lsof for the specific pid — ~10-50ms, fine since we only call it
//        after the user presses Enter (not on a tight poll).
async function getCwd(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      return null; // Windows CWD is shell-reported instead of parent-polled.
    }
    if (process.platform === "linux") {
      return readlinkSync(`/proc/${pid}/cwd`);
    }
    if (process.platform === "darwin") {
      const proc = Bun.spawn(
        ["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const text = await new Response(proc.stdout).text();
      const match = text.match(/^n(.+)$/m);
      return match ? match[1].trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

const CWD_REFRESH_RETRY_DELAYS_MS = [200, 400, 800];

// Schedule a CWD refresh after Enter. Browser clients send one WS frame per
// keypress, so a single 200ms sample can land before the shell has consumed
// the full command and updated its cwd. Retry briefly before falling back to
// the 30s background poll.
function scheduleCwdRefresh(session: Session) {
  if (session.cwdTimer) clearTimeout(session.cwdTimer);
  const baselineCwd = session.cwd;
  let attempt = 0;

  const refresh = async () => {
    session.cwdTimer = null;
    if (!session.proc) return;
    const cwd = await getCwd(session.proc.pid);
    if (cwd && cwd !== session.cwd) {
      session.cwd = cwd;
      broadcastSessions();
      return;
    }
    // Another path already updated the session; no need to keep retrying.
    if (session.cwd !== baselineCwd) return;
    attempt += 1;
    if (attempt >= CWD_REFRESH_RETRY_DELAYS_MS.length) return;
    session.cwdTimer = setTimeout(refresh, CWD_REFRESH_RETRY_DELAYS_MS[attempt]);
  };

  session.cwdTimer = setTimeout(refresh, CWD_REFRESH_RETRY_DELAYS_MS[attempt]);
}

function sessionInfo(s: Session) {
  return { id: s.id, hostId: HOST_CONFIG.self.id, name: s.name, createdAt: s.createdAt, clients: s.clients.size, cwd: s.cwd };
}

function detachClient(ws: ServerWebSocket<WSData>): boolean {
  const sessionId = ws.data.sessionId;
  if (!sessionId) return false;
  ws.data.sessionId = null;
  const session = sessions.get(sessionId);
  if (!session) return false;
  return session.clients.delete(ws);
}

function safeSend(ws: ServerWebSocket<WSData>, payload: string): boolean {
  try {
    ws.send(payload);
    return true;
  } catch {
    listSubscribers.delete(ws);
    detachClient(ws);
    return false;
  }
}

function broadcastSessions() {
  const list = [...sessions.values()].map(sessionInfo);
  const msg = JSON.stringify({ type: "sessions", list });
  const recipients = new Set<ServerWebSocket<WSData>>(listSubscribers);
  for (const s of sessions.values()) {
    for (const ws of s.clients) recipients.add(ws);
  }
  for (const ws of recipients) safeSend(ws, msg);
}

function createSession(name: string, cols: number, rows: number, cwd?: string): Session {
  const id = randomUUID();
  const shell = defaultShell();
  const session: Session = {
    id,
    name: name?.trim() || pickSessionName(),
    proc: null,
    shell,
    buffer: Buffer.alloc(0),
    bufferTrimmed: false,
    clients: new Set(),
    createdAt: Date.now(),
    cwd: "",
    cwdTimer: null,
    shellControlRemainder: "",
    shellTracksCwd: process.platform === "win32" && isGitBashShell(shell),
  };

  const baseEnv = Object.fromEntries(
    Object.entries({ ...process.env, TERM: "xterm-256color" }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  const env = prepareEnvForShell(shell, baseEnv);

  const proc = spawnPty({
    shell,
    cwd: cwd || defaultCwd(),
    cols,
    rows,
    env,
    onData(data) {
      let payload = Buffer.from(data);
      if (session.shellTracksCwd) {
        const extracted = stripWindowsCwdControlFrames(payload, session.shellControlRemainder);
        payload = Buffer.from(extracted.data);
        session.shellControlRemainder = extracted.remainder;
        if (extracted.cwd && extracted.cwd !== session.cwd) {
          session.cwd = extracted.cwd;
          broadcastSessions();
        }
      }

      // Append to scrollback buffer (capped)
      const combined = Buffer.concat([session.buffer, payload]);
      if (combined.length > MAX_BUFFER) {
        session.buffer = combined.subarray(combined.length - MAX_BUFFER);
        session.bufferTrimmed = true;
      } else {
        session.buffer = combined;
      }

      // Broadcast raw bytes to all attached clients
      if (payload.length > 0) {
        for (const ws of session.clients) ws.sendBinary(payload);
      }
    },
    onExit() {
      if (session.cwdTimer) clearTimeout(session.cwdTimer);
      sessions.delete(id);
      const msg = JSON.stringify({ type: "session-exit", id });
      for (const ws of session.clients) ws.send(msg);
      broadcastSessions();
    },
  });

  session.proc = proc;
  sessions.set(id, session);

  // Read initial CWD once the shell has started
  getCwd(proc.pid).then((cwd) => {
    if (cwd) { session.cwd = cwd; broadcastSessions(); }
  });

  return session;
}

// Slow background poll as a fallback for script-driven `cd`s (e.g. sourcing a
// file, running a script that changes directory). The Enter-key debounce handles
// the common interactive case; this catches anything that slips through.
// Re-registered on --hot reloads to avoid duplicate intervals.
if (g.__wt_cwd_poll) clearInterval(g.__wt_cwd_poll);
g.__wt_cwd_poll = setInterval(async () => {
  let changed = false;
  await Promise.all(
    [...sessions.values()].map(async (s) => {
      if (!s.proc) return;
      const cwd = await getCwd(s.proc.pid);
      if (cwd && cwd !== s.cwd) { s.cwd = cwd; changed = true; }
    })
  );
  if (changed) broadcastSessions();
}, 30_000);

const server = Bun.serve<WSData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (!isAllowedWsOrigin(req, TRUSTED_PEER_HOSTNAMES)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (server.upgrade(req, { data: { sessionId: null } })) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    if (url.pathname === "/api/version") {
      return Response.json({ version: getCurrentVersion() ?? "dev" });
    }

    if (url.pathname === "/api/host") {
      return Response.json({
        self: HOST_CONFIG.self,
        peers: HOST_CONFIG.peers,
      });
    }

    // Serve built frontend (production: bun run build && bun run start)
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`./dist${filePath}`);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      safeSend(ws, JSON.stringify({
        type: "host-info",
        id: HOST_CONFIG.self.id,
        name: HOST_CONFIG.self.name,
      }));
    },

    message(ws, msg) {
      // Binary = terminal input from client (shouldn't happen but ignore)
      if (typeof msg !== "string") return;

      let data: ParsedClientMessage;
      try {
        const parsed = JSON.parse(msg);
        if (!parsed || typeof parsed !== "object") return;
        const record = parsed as Record<string, unknown>;
        if (typeof record.type !== "string") return;
        data = record as ParsedClientMessage;
      } catch {
        return;
      }

      const session = ws.data.sessionId ? sessions.get(ws.data.sessionId) : null;

      switch (data.type) {
        case "list": {
          listSubscribers.add(ws);
          ws.send(JSON.stringify({ type: "sessions", list: [...sessions.values()].map(sessionInfo) }));
          break;
        }

        case "detach": {
          if (detachClient(ws)) {
            broadcastSessions();
          }
          break;
        }

        case "create": {
          // Detach from any current session
          if (session) session.clients.delete(ws);

          const name = asString(data.name) ?? "";
          const cols = asPositiveInt(data.cols) ?? 80;
          const rows = asPositiveInt(data.rows) ?? 24;
          const cwdRaw = asString(data.cwd);
          const cwd = cwdRaw && cwdRaw.trim().length > 0 ? cwdRaw : undefined;
          const requestId = asString(data.requestId);
          const s = createSession(name, cols, rows, cwd);
          ws.data.sessionId = s.id;
          // sessions before ready — client needs the new session in its list so
          // the container div exists in the DOM when the ready handler fires.
          broadcastSessions();
          ws.send(JSON.stringify({
            type: "ready",
            id: s.id,
            name: s.name,
            fresh: true,
            ...(requestId !== null ? { requestId } : {}),
          }));
          // Attach only after ready so no binary from the new PTY can arrive
          // before client-side routing flips to this new session.
          s.clients.add(ws);
          if (s.buffer.length > 0) ws.sendBinary(s.buffer);
          broadcastSessions();
          break;
        }

        case "attach": {
          const id = asString(data.id);
          const requestId = asString(data.requestId);
          const s = id ? sessions.get(id) : null;
          if (!s) {
            ws.send(JSON.stringify({
              type: "error",
              message: "Session not found",
              ...(requestId !== null ? { requestId } : {}),
            }));
            return;
          }

          // Detach from old session
          if (session && session !== s) session.clients.delete(ws);

          // Attach to new session
          ws.data.sessionId = s.id;
          s.clients.add(ws);
          broadcastSessions();

          // Resize to match client dimensions
          const cols = asPositiveInt(data.cols);
          const rows = asPositiveInt(data.rows);
          if (cols && rows) s.proc?.resize(cols, rows);

          ws.send(JSON.stringify({
            type: "ready",
            id: s.id,
            name: s.name,
            ...(requestId !== null ? { requestId } : {}),
          }));
          // Replay after ready so client can validate requestId first and drop
          // stale attach responses before any scrollback bytes are applied.
          const replay = sanitizeReplayBuffer(s.buffer, s.bufferTrimmed);
          if (replay.length > 0) ws.sendBinary(replay);
          break;
        }

        case "input": {
          const input = asString(data.data);
          if (!session || input === null) return;
          session.proc?.write(input);
          // Enter key — schedule a CWD refresh after the command has time to run
          if (input === "\r") scheduleCwdRefresh(session);
          break;
        }

        case "resize": {
          const cols = asPositiveInt(data.cols);
          const rows = asPositiveInt(data.rows);
          if (!session || !cols || !rows) return;
          session.proc?.resize(cols, rows);
          break;
        }

        case "rename": {
          const id = asString(data.id);
          if (!id) return;
          const s = sessions.get(id);
          if (!s) return;
          const nextName = asString(data.name);
          s.name = (nextName ?? "").trim() || s.name;
          broadcastSessions();
          break;
        }

        case "kill": {
          const id = asString(data.id);
          if (!id) return;
          const s = sessions.get(id);
          if (!s) return;
          if (s.cwdTimer) clearTimeout(s.cwdTimer);
          sessions.delete(id);
          const exitMsg = JSON.stringify({ type: "session-exit", id });
          for (const c of s.clients) c.send(exitMsg);
          s.proc?.kill();
          broadcastSessions();
          break;
        }
      }
    },

    close(ws) {
      const session = ws.data.sessionId ? sessions.get(ws.data.sessionId) : null;
      if (session) {
        session.clients.delete(ws);
        broadcastSessions();
      }
      listSubscribers.delete(ws);
    },
  },
});

console.log(`ting.sh listening on http://localhost:${server.port}`);

// --- Auto-update ---
// Polls GitHub releases, downloads new version, extracts over current install,
// then exits so systemd restarts with the new code.
// Disabled in dev (no VERSION file) or when AUTO_UPDATE=false.

const AUTO_UPDATE_REPO = process.env.AUTO_UPDATE_REPO ?? "andrewting19/ting.sh";
const AUTO_UPDATE_INTERVAL = parseInt(process.env.AUTO_UPDATE_INTERVAL ?? String(5 * 60_000)); // 5 min default
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
  if (!current) return; // no VERSION file = dev mode, skip
  const isWindows = process.platform === "win32";

  try {
    const res = await fetch(`https://api.github.com/repos/${AUTO_UPDATE_REPO}/releases/latest`, {
      headers: { "Accept": "application/vnd.github+json" },
    });
    if (!res.ok) return;

    const data = await res.json() as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> };
    const tag = data.tag_name;
    if (!tag) return;

    const latest = tag.replace(/^v/, "");
    if (latest === current) return;

    console.log(`[auto-update] new version available: v${latest} (current: v${current})`);

    const asset = data.assets?.find(a => (isWindows ? a.name.endsWith(".zip") : a.name.endsWith(".tar.gz")));
    if (!asset) {
      console.log(`[auto-update] no ${isWindows ? "zip" : "tar.gz"} asset found in release`);
      return;
    }

    // Download and extract over current directory
    console.log(`[auto-update] downloading ${asset.name}...`);
    const releaseRes = await fetch(asset.browser_download_url);
    if (!releaseRes.ok || !releaseRes.body) {
      console.log("[auto-update] download failed");
      return;
    }

    // Write to temp file, then extract
    const ext = isWindows ? ".zip" : ".tar.gz";
    const tmpPath = join(".", `.update-${latest}${ext}`);
    const releaseBytes = new Uint8Array(await releaseRes.arrayBuffer());
    writeFileSync(tmpPath, releaseBytes);

    const extract = isWindows
      ? Bun.spawn(
          [
            "powershell",
            "-NoProfile",
            "-Command",
            `Expand-Archive -Path '${tmpPath}' -DestinationPath '.' -Force`,
          ],
          { stdout: "pipe", stderr: "pipe" }
        )
      : Bun.spawn(["tar", "xzf", tmpPath, "-C", "."], {
          stdout: "pipe",
          stderr: "pipe",
        });
    await extract.exited;

    if (extract.exitCode !== 0) {
      const stderr = await new Response(extract.stderr).text();
      console.log(`[auto-update] extract failed: ${stderr}`);
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      return;
    }

    try { unlinkSync(tmpPath); } catch { /* ignore */ }

    console.log("[auto-update] installing updated dependencies...");
    const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await install.exited;
    if (install.exitCode !== 0) {
      const stderr = await new Response(install.stderr).text();
      console.log(`[auto-update] bun install failed: ${stderr}`);
      return;
    }

    console.log(`[auto-update] updated to v${latest}, restarting...`);
    process.exit(0); // systemd restarts us
  } catch (err) {
    console.log(`[auto-update] check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (AUTO_UPDATE_ENABLED) {
  // Check once on startup (after a short delay to let the server settle)
  setTimeout(checkForUpdate, 10_000);
  // Then periodically
  setInterval(checkForUpdate, AUTO_UPDATE_INTERVAL);
  console.log(`[auto-update] enabled, checking ${AUTO_UPDATE_REPO} every ${AUTO_UPDATE_INTERVAL / 60_000}min`);
} else {
  console.log("[auto-update] disabled");
}
