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

test("ghostty attach-snapshot returns rendered-text snapshot payload", async () => {
  const serverPort = await getFreePort();
  const ptydPort = await getFreePort();
  const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
  let ptyd: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let writer: WsHarness | null = null;
  let reader: WsHarness | null = null;

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

    writer = new WsHarness(wsUrl);
    await writer.open();
    await writer.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    writer.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-1" });
    const ready = await writer.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-1",
    );
    const sessionId = ready.id;

    const marker = `ghostty-snapshot-${Date.now()}`;
    writer.sendJson({ type: "input", data: `printf '${marker}\\n'\r` });
    await writer.nextBinaryContaining(marker);

    reader = new WsHarness(wsUrl);
    await reader.open();
    await reader.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    reader.sendJson({ type: "attach-snapshot", id: sessionId, cols: 80, rows: 24, requestId: "snap-1", renderer: "ghostty" });
    const snapshotReady = await reader.nextJsonWhere<{
      type: string;
      backend: string;
      snapshot: {
        format: string;
        activeBuffer: string;
        normalLines: Array<{ text: string; wrapped: boolean }>;
      };
      requestId?: string;
    }>((msg) => msg.type === "snapshot-ready" && msg.requestId === "snap-1");

    expect(snapshotReady.backend).toBe("rendered-text-snapshot-v1");
    expect(snapshotReady.snapshot.format).toBe("rendered-text-snapshot-v1");
    expect(snapshotReady.snapshot.activeBuffer).toBe("normal");
    expect(snapshotReady.snapshot.normalLines.some((line) => line.text.includes(marker))).toBe(true);
  } finally {
    writer?.close();
    reader?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);

test("ghostty attach-snapshot returns xterm VT snapshot for alternate-screen sessions", async () => {
  const serverPort = await getFreePort();
  const ptydPort = await getFreePort();
  const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
  let ptyd: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let writer: WsHarness | null = null;
  let reader: WsHarness | null = null;

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

    writer = new WsHarness(wsUrl);
    await writer.open();
    await writer.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    writer.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-alt" });
    const ready = await writer.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-alt",
    );
    const sessionId = ready.id;

    writer.sendJson({
      type: "input",
      data: "printf 'normal-1\\nnormal-2\\n'; printf '\\033[?1049h\\033[2J\\033[HALT HEADER\\nstatus: running'; printf '\\033[4;6Hcursor-here'\r",
    });
    await writer.nextBinaryContaining("ALT HEADER");

    reader = new WsHarness(wsUrl);
    await reader.open();
    await reader.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    reader.sendJson({ type: "attach-snapshot", id: sessionId, cols: 80, rows: 24, requestId: "snap-alt", renderer: "ghostty" });
    const snapshotReady = await reader.nextJsonWhere<{
      type: string;
      backend: string;
      snapshot: {
        format: string;
        payload: string;
      };
      requestId?: string;
    }>((msg) => msg.type === "snapshot-ready" && msg.requestId === "snap-alt");

    expect(snapshotReady.backend).toBe("xterm-vt-snapshot-v1");
    expect(snapshotReady.snapshot.format).toBe("xterm-vt-snapshot-v1");
    expect(snapshotReady.snapshot.payload).toContain("ALT HEADER");
    expect(snapshotReady.snapshot.payload).toContain("cursor-here");
  } finally {
    writer?.close();
    reader?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);
