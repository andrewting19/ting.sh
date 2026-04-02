import { expect, test } from "bun:test";

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  await server.stop();
  return port;
}

async function waitForHttpOk(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class WsHarness {
  private queue: Array<string | Uint8Array> = [];
  private waiters: Array<(message: string | Uint8Array) => void> = [];
  readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (event) => {
      const message = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : String(event.data);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
        return;
      }
      this.queue.push(message);
    };
  }

  async open(timeoutMs = 10_000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out opening WebSocket")), timeoutMs);
      this.ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket failed to open"));
      };
    });
  }

  async nextMessage(timeoutMs = 10_000): Promise<string | Uint8Array> {
    if (this.queue.length > 0) return this.queue.shift()!;
    return await new Promise<string | Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }

  sendJson(value: object): void {
    this.ws.send(JSON.stringify(value));
  }

  async nextJsonWhere<T extends Record<string, unknown>>(
    predicate: (value: T) => boolean,
    timeoutMs = 10_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const message = await this.nextMessage(remaining);
      if (typeof message !== "string") continue;
      const parsed = JSON.parse(message) as T;
      if (predicate(parsed)) return parsed;
    }
    throw new Error("Timed out waiting for matching JSON WebSocket message");
  }

  async nextBinaryContaining(needle: string, timeoutMs = 10_000): Promise<string> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let text = "";
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const message = await this.nextMessage(remaining);
      if (typeof message === "string") continue;
      text += decoder.decode(message, { stream: true });
      if (text.includes(needle)) return text;
    }
    throw new Error(`Timed out waiting for binary output containing "${needle}"`);
  }

  close(): void {
    this.ws.close();
  }
}

function spawnBunScript(script: string, env: Record<string, string>): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([process.execPath, "run", script], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function terminateProcess(proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null): Promise<void> {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    // already exited
  }
  await proc.exited;
}

test("server debug proxy forwards to the active sidecar", async () => {
  const serverPort = await getFreePort();
  const ptydPort = await getFreePort();
  const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
  let ptyd: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let client: WsHarness | null = null;

  try {
    ptyd = spawnBunScript("ptyd.ts", {
      PTYD_PORT: String(ptydPort),
      PTYD_IDLE_EXIT_MS: "0",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    server = spawnBunScript("server.ts", {
      PORT: String(serverPort),
      PTYD_PORT: String(ptydPort),
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${serverBaseUrl}/api/host`);

    const sidecarRes = await fetch(`${serverBaseUrl}/api/sidecar`);
    expect(sidecarRes.ok).toBe(true);
    const sidecar = await sidecarRes.json() as {
      baseUrl: string;
      wsUrl: string;
      port: number;
      health: {
        ok: boolean;
        sessions: number;
        pid: number;
        startedAt: number;
        runtimeFingerprint: string;
        currentFingerprint: string;
        staleRuntime: boolean;
      };
    };
    expect(sidecar.port).toBe(ptydPort);
    expect(sidecar.baseUrl).toBe(`http://127.0.0.1:${ptydPort}`);
    expect(sidecar.health.ok).toBe(true);
    expect(typeof sidecar.health.pid).toBe("number");
    expect(sidecar.health.startedAt).toBeGreaterThan(0);
    expect(sidecar.health.runtimeFingerprint.length).toBeGreaterThan(0);
    expect(sidecar.health.currentFingerprint.length).toBeGreaterThan(0);
    expect(sidecar.health.staleRuntime).toBe(false);

    client = new WsHarness(wsUrl);
    await client.open();
    await client.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    client.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-1" });
    const ready = await client.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-1",
    );

    const marker = `server-proxy-${Date.now()}`;
    client.sendJson({ type: "input", data: `printf '${marker}\\n'\r` });
    await client.nextBinaryContaining(marker);

    const debugRes = await fetch(`${serverBaseUrl}/api/debug/session?id=${encodeURIComponent(ready.id)}&includeRaw=1`);
    expect(debugRes.ok).toBe(true);
    const debug = await debugRes.json() as {
      id: string;
      snapshot: { payload: string };
      rawReplayBase64?: string;
    };
    expect(debug.id).toBe(ready.id);
    expect(debug.snapshot.payload).toContain(marker);
    expect(Buffer.from(debug.rawReplayBase64 ?? "", "base64").toString("utf8")).toContain(marker);
  } finally {
    client?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);
