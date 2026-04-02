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
      // keep polling until timeout
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForHttpDown(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${url} to stop responding`);
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

test("sessions survive Bun server restart when ptyd stays alive", async () => {
  const serverPort = await getFreePort();
  const ptydPort = await getFreePort();
  const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const ptydBaseUrl = `http://127.0.0.1:${ptydPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
  let ptyd: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let client1: WsHarness | null = null;
  let client2: WsHarness | null = null;

  try {
    ptyd = spawnBunScript("ptyd.ts", {
      PTYD_PORT: String(ptydPort),
      PTYD_IDLE_EXIT_MS: "0",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${ptydBaseUrl}/health`);

    server = spawnBunScript("server.ts", {
      PORT: String(serverPort),
      PTYD_PORT: String(ptydPort),
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${serverBaseUrl}/api/host`);

    client1 = new WsHarness(wsUrl);
    await client1.open();
    await client1.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");

    client1.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-1" });
    const ready = await client1.nextJsonWhere<{ type: string; id: string; name: string; requestId?: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-1",
    );
    const sessionId = ready.id;
    const sessionName = ready.name;
    const beforeMarker = `before-restart-${Date.now()}`;
    client1.sendJson({ type: "input", data: `printf '${beforeMarker}\\n'\r` });
    await client1.nextBinaryContaining(beforeMarker);

    await terminateProcess(server);
    server = null;
    await waitForHttpDown(`${serverBaseUrl}/api/host`);

    server = spawnBunScript("server.ts", {
      PORT: String(serverPort),
      PTYD_PORT: String(ptydPort),
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${serverBaseUrl}/api/host`);

    client2 = new WsHarness(wsUrl);
    await client2.open();
    await client2.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    client2.sendJson({ type: "list" });
    const sessions = await client2.nextJsonWhere<{ type: string; list: Array<{ id: string; name: string }> }>(
      (msg) => msg.type === "sessions" && Array.isArray(msg.list) && msg.list.some((session) => session.id === sessionId),
    );
    expect(sessions.list.some((session) => session.id === sessionId && session.name === sessionName)).toBe(true);

    client2.sendJson({ type: "attach", id: sessionId, cols: 80, rows: 24, requestId: "attach-1" });
    await client2.nextJsonWhere<{ type: string; id: string; requestId?: string }>(
      (msg) => msg.type === "ready" && msg.id === sessionId && msg.requestId === "attach-1",
    );
    await client2.nextBinaryContaining(beforeMarker);

    const afterMarker = `after-restart-${Date.now()}`;
    client2.sendJson({ type: "input", data: `printf '${afterMarker}\\n'\r` });
    await client2.nextBinaryContaining(afterMarker);
  } finally {
    client1?.close();
    client2?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);
