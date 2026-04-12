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

test("snapshot attach emits snapshot-ready then tail after client ack", async () => {
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
      TING_PORT: String(serverPort),
      PTYD_PORT: String(ptydPort),
      PTYD_AUTOSPAWN: "false",
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

    const beforeMarker = `before-snapshot-${Date.now()}`;
    writer.sendJson({ type: "input", data: `printf '${beforeMarker}\\n'\r` });
    await writer.nextBinaryContaining(beforeMarker);

    reader = new WsHarness(wsUrl);
    await reader.open();
    await reader.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    reader.sendJson({ type: "attach-snapshot", id: sessionId, cols: 80, rows: 24, requestId: "snap-1" });
    const snapshotReady = await reader.nextJsonWhere<{
      type: string;
      id: string;
      backend: string;
      cutSeq: number;
      snapshot: { payload: string };
      requestId?: string;
    }>((msg) => msg.type === "snapshot-ready" && msg.requestId === "snap-1");

    expect(snapshotReady.backend).toBe("xterm-vt-snapshot-v1");
    expect(snapshotReady.snapshot.payload.length).toBeGreaterThan(0);

    const duringMarker = `during-snapshot-${Date.now()}`;
    writer.sendJson({ type: "input", data: `printf '${duringMarker}\\n'\r` });
    await writer.nextBinaryContaining(duringMarker);

    reader.sendJson({ type: "snapshot-applied", id: sessionId, requestId: "snap-1" });
    const tailMessages: Array<{ seq: number; text: string }> = [];
    let snapshotComplete:
      | { type: string; id: string; cutSeq: number; tailSeq: number; requestId?: string }
      | null = null;
    while (!snapshotComplete) {
      const message = await reader.nextMessage();
      if (typeof message !== "string") continue;
      const parsed = JSON.parse(message) as
        | { type: "snapshot-tail"; id: string; seq: number; data: string; requestId?: string }
        | { type: "snapshot-complete"; id: string; cutSeq: number; tailSeq: number; requestId?: string };
      if (parsed.requestId !== "snap-1" || parsed.id !== sessionId) continue;
      if (parsed.type === "snapshot-tail") {
        tailMessages.push({
          seq: parsed.seq,
          text: Buffer.from(parsed.data, "base64").toString("utf8"),
        });
        continue;
      }
      if (parsed.type === "snapshot-complete") snapshotComplete = parsed;
    }

    expect(tailMessages.length).toBeGreaterThan(0);
    expect(tailMessages.some((tail) => tail.text.includes(duringMarker))).toBe(true);
    for (const tail of tailMessages) {
      expect(tail.seq).toBeGreaterThan(snapshotReady.cutSeq);
    }
    expect(snapshotComplete.cutSeq).toBe(snapshotReady.cutSeq);
    expect(snapshotComplete.tailSeq).toBeGreaterThanOrEqual(snapshotReady.cutSeq);

    const afterMarker = `after-snapshot-${Date.now()}`;
    writer.sendJson({ type: "input", data: `printf '${afterMarker}\\n'\r` });
    await reader.nextBinaryContaining(afterMarker);
  } finally {
    writer?.close();
    reader?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);

test("xterm snapshot attach keeps shared sessions live for existing and newly attached clients", async () => {
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
      TING_PORT: String(serverPort),
      PTYD_PORT: String(ptydPort),
      PTYD_AUTOSPAWN: "false",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${serverBaseUrl}/api/host`);

    writer = new WsHarness(wsUrl);
    await writer.open();
    await writer.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    writer.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-shared-xterm" });
    const ready = await writer.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-shared-xterm",
    );
    const sessionId = ready.id;

    const beforeMarker = `shared-before-${Date.now()}`;
    writer.sendJson({ type: "input", data: `printf '${beforeMarker}\\n'\r` });
    await writer.nextBinaryContaining(beforeMarker);

    reader = new WsHarness(wsUrl);
    await reader.open();
    await reader.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    reader.sendJson({ type: "attach-snapshot", id: sessionId, cols: 80, rows: 24, requestId: "snap-shared-xterm" });
    const snapshotReady = await reader.nextJsonWhere<{
      type: string;
      id: string;
      backend: string;
      requestId?: string;
    }>((msg) => msg.type === "snapshot-ready" && msg.requestId === "snap-shared-xterm");
    expect(snapshotReady.backend).toBe("xterm-vt-snapshot-v1");

    reader.sendJson({ type: "snapshot-applied", id: sessionId, requestId: "snap-shared-xterm" });
    await reader.nextJsonWhere<{ type: string; requestId?: string }>(
      (msg) => msg.type === "snapshot-complete" && msg.requestId === "snap-shared-xterm",
    );

    const afterMarker = `shared-after-${Date.now()}`;
    writer.sendJson({ type: "input", data: `printf '${afterMarker}\\n'\r` });
    await writer.nextBinaryContaining(afterMarker);
    await reader.nextBinaryContaining(afterMarker);
  } finally {
    writer?.close();
    reader?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);
