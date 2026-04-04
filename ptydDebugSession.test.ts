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

test("ptyd debug session endpoint returns consistent snapshot and raw replay", async () => {
  const ptydPort = await getFreePort();
  const ptydBaseUrl = `http://127.0.0.1:${ptydPort}`;
  const wsUrl = `ws://127.0.0.1:${ptydPort}/ws`;
  let ptyd: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let client: WsHarness | null = null;

  try {
    ptyd = spawnBunScript("ptyd.ts", {
      PTYD_PORT: String(ptydPort),
      PTYD_IDLE_EXIT_MS: "0",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${ptydBaseUrl}/health`);

    client = new WsHarness(wsUrl);
    await client.open();
    client.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-1" });
    const ready = await client.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-1",
    );

    const marker = `debug-session-${Date.now()}`;
    client.sendJson({ type: "input", data: `printf '${marker}\\n'\r` });
    await client.nextBinaryContaining(marker);

    const res = await fetch(`${ptydBaseUrl}/debug/session?id=${encodeURIComponent(ready.id)}&includeRaw=1`);
    expect(res.ok).toBe(true);
    const debug = await res.json() as {
      id: string;
      name: string;
      initialCols: number;
      initialRows: number;
      outputSeq: number;
      snapshotSeq: number;
      bufferBytes: number;
      bufferTrimmed: boolean;
      liveTailBytes: number;
      liveTailSeq: number;
      traceEventCount: number;
      traceDataBytes: number;
      traceEvents: Array<
        | { type: "data"; base64: string; bytes: number }
        | { type: "resize"; cols: number; rows: number }
      >;
      snapshotBytes: number;
      renderedTextSnapshotBytes: number;
      snapshot: { format: string; payload: string };
      renderedTextSnapshot: { format: string; activeBuffer: string };
      canonicalSnapshot: { format: string; activeBuffer: string };
      rawReplayBase64?: string;
    };

    expect(debug.id).toBe(ready.id);
    expect(debug.initialCols).toBe(80);
    expect(debug.initialRows).toBe(24);
    expect(debug.outputSeq).toBeGreaterThan(0);
    expect(debug.snapshotSeq).toBeGreaterThan(0);
    expect(debug.snapshotSeq).toBeLessThanOrEqual(debug.outputSeq);
    expect(debug.liveTailSeq).toBe(debug.outputSeq);
    expect(debug.traceEventCount).toBeGreaterThan(0);
    expect(debug.traceDataBytes).toBeGreaterThan(0);
    expect(debug.traceEvents.some((event) => event.type === "data")).toBe(true);
    expect(debug.bufferBytes).toBeGreaterThan(0);
    expect(debug.snapshotBytes).toBeGreaterThan(0);
    expect(debug.renderedTextSnapshotBytes).toBeGreaterThan(0);
    expect(debug.snapshot.format).toBe("xterm-vt-snapshot-v1");
    expect(debug.renderedTextSnapshot.format).toBe("rendered-text-snapshot-v1");
    expect(debug.canonicalSnapshot.format).toBe("canonical-terminal-snapshot-v1");
    expect(debug.renderedTextSnapshot.activeBuffer).toBe("normal");
    expect(debug.canonicalSnapshot.activeBuffer).toBe("normal");
    expect(debug.snapshot.payload).toContain(marker);
    expect(debug.bufferTrimmed).toBe(false);
    expect(debug.rawReplayBase64).toBeTruthy();
    expect(Buffer.from(debug.rawReplayBase64!, "base64").toString("utf8")).toContain(marker);
  } finally {
    client?.close();
    await terminateProcess(ptyd);
  }
}, 60_000);

test("ptyd debug session trace events include explicit resizes", async () => {
  const ptydPort = await getFreePort();
  const ptydBaseUrl = `http://127.0.0.1:${ptydPort}`;
  const wsUrl = `ws://127.0.0.1:${ptydPort}/ws`;
  let ptyd: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let client: WsHarness | null = null;

  try {
    ptyd = spawnBunScript("ptyd.ts", {
      PTYD_PORT: String(ptydPort),
      PTYD_IDLE_EXIT_MS: "0",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${ptydBaseUrl}/health`);

    client = new WsHarness(wsUrl);
    await client.open();
    client.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-resize" });
    const ready = await client.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-resize",
    );

    client.sendJson({ type: "resize", cols: 100, rows: 30 });
    client.sendJson({ type: "resize", cols: 100, rows: 30 });
    client.sendJson({ type: "input", data: "printf 'after-resize\\n'\r" });
    await client.nextBinaryContaining("after-resize");

    const res = await fetch(`${ptydBaseUrl}/debug/session?id=${encodeURIComponent(ready.id)}&includeRaw=1`);
    expect(res.ok).toBe(true);
    const debug = await res.json() as {
      initialCols: number;
      initialRows: number;
      traceEvents: Array<
        | { type: "data"; base64: string; bytes: number }
        | { type: "resize"; cols: number; rows: number }
      >;
      snapshot: { cols: number; rows: number; payload: string };
    };

    expect(debug.initialCols).toBe(80);
    expect(debug.initialRows).toBe(24);
    expect(debug.snapshot.cols).toBe(100);
    expect(debug.snapshot.rows).toBe(30);
    const matchingResizes = debug.traceEvents.filter(
      (event) => event.type === "resize" && event.cols === 100 && event.rows === 30,
    );
    expect(matchingResizes).toHaveLength(1);
    expect(debug.snapshot.payload).toContain("after-resize");
  } finally {
    client?.close();
    await terminateProcess(ptyd);
  }
}, 60_000);

test("ptyd debug session snapshots preserve UTF-8 box drawing glyphs", async () => {
  const ptydPort = await getFreePort();
  const ptydBaseUrl = `http://127.0.0.1:${ptydPort}`;
  const wsUrl = `ws://127.0.0.1:${ptydPort}/ws`;
  let ptyd: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let client: WsHarness | null = null;

  try {
    ptyd = spawnBunScript("ptyd.ts", {
      PTYD_PORT: String(ptydPort),
      PTYD_IDLE_EXIT_MS: "0",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${ptydBaseUrl}/health`);

    client = new WsHarness(wsUrl);
    await client.open();
    client.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-utf8" });
    const ready = await client.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-utf8",
    );

    client.sendJson({
      type: "input",
      data:
        "printf '\\xE2\\x95\\xAD\\xE2\\x94\\x80\\xE2\\x94\\x80\\xE2\\x94\\x80\\xE2\\x94\\x80\\xE2\\x95\\xAE\\r\\n\\xE2\\x94\\x82 menu \\xE2\\x94\\x82\\r\\n\\xE2\\x95\\xB0\\xE2\\x94\\x80\\xE2\\x94\\x80\\xE2\\x94\\x80\\xE2\\x94\\x80\\xE2\\x95\\xAF\\r\\n'\r",
    });
    await client.nextBinaryContaining("╭────╮");

    const res = await fetch(`${ptydBaseUrl}/debug/session?id=${encodeURIComponent(ready.id)}&includeRaw=1`);
    expect(res.ok).toBe(true);
    const debug = await res.json() as {
      snapshot: { payload: string };
      renderedTextSnapshot: { normalLines: Array<{ text: string }> };
      rawReplayBase64?: string;
    };

    const raw = Buffer.from(debug.rawReplayBase64 ?? "", "base64").toString("utf8");
    const renderedText = JSON.stringify(debug.renderedTextSnapshot);
    expect(raw).toContain("╭────╮");
    expect(debug.snapshot.payload).toContain("╭────╮");
    expect(renderedText).toContain("╭────╮");
    expect(debug.snapshot.payload).not.toContain("â");
    expect(renderedText).not.toContain("â");
  } finally {
    client?.close();
    await terminateProcess(ptyd);
  }
}, 60_000);
