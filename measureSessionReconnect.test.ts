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

test("measure-session-reconnect script reports raw and snapshot attach metrics", async () => {
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
      TING_PORT: String(serverPort),
      PTYD_PORT: String(ptydPort),
      PTYD_AUTOSPAWN: "false",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${serverBaseUrl}/api/host`);

    client = new WsHarness(wsUrl);
    await client.open();
    await client.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");
    client.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-1" });
    const ready = await client.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-1",
    );

    const marker = `measure-reconnect-${Date.now()}`;
    client.sendJson({ type: "input", data: `printf '${marker}\\n'\r` });
    await client.nextBinaryContaining(marker);

    client.close();
    client = null;

    async function runMeasure(renderer: string): Promise<{
      sessionId: string;
      renderer: string;
      raw: { replayBytesReceived: number; replayChunkCount: number; durationMs: number | null };
      snapshot: {
        backend: string | null;
        snapshotBytes: number | null;
        durationMs: number | null;
      };
    }> {
      const measure = Bun.spawn([process.execPath, "run", "scripts/measure-session-reconnect.ts", ready.id, renderer], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          SERVER_PORT: String(serverPort),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(measure.stdout).text();
      const stderr = await new Response(measure.stderr).text();
      await measure.exited;
      expect(measure.exitCode).toBe(0);
      expect(stderr).toBe("");
      return JSON.parse(stdout) as {
        sessionId: string;
        renderer: string;
        raw: { replayBytesReceived: number; replayChunkCount: number; durationMs: number | null };
        snapshot: {
          backend: string | null;
          snapshotBytes: number | null;
          durationMs: number | null;
        };
      };
    }

    const xterm = await runMeasure("xterm");
    expect(xterm.sessionId).toBe(ready.id);
    expect(xterm.renderer).toBe("xterm");
    expect(xterm.raw.replayBytesReceived).toBeGreaterThan(0);
    expect(xterm.raw.replayChunkCount).toBeGreaterThan(0);
    expect(xterm.raw.durationMs).not.toBeNull();
    expect(xterm.snapshot.backend).toBe("xterm-vt-snapshot-v1");
    expect(xterm.snapshot.snapshotBytes).toBeGreaterThan(0);
    expect(xterm.snapshot.durationMs).not.toBeNull();

    const ghostty = await runMeasure("ghostty");
    expect(ghostty.sessionId).toBe(ready.id);
    expect(ghostty.renderer).toBe("ghostty");
    expect(ghostty.raw.replayBytesReceived).toBeGreaterThan(0);
    expect(ghostty.snapshot.backend).toBe("xterm-vt-snapshot-v1");
    expect(ghostty.snapshot.snapshotBytes).toBeGreaterThan(0);
    expect(ghostty.snapshot.durationMs).not.toBeNull();
  } finally {
    client?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);

test("measure-session-reconnect script can measure all live sessions", async () => {
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
      TING_PORT: String(serverPort),
      PTYD_PORT: String(ptydPort),
      PTYD_AUTOSPAWN: "false",
      HOSTS_FILE: "none",
      AUTO_UPDATE: "false",
      SHELL: "/bin/bash",
    });
    await waitForHttpOk(`${serverBaseUrl}/api/host`);

    client = new WsHarness(wsUrl);
    await client.open();
    await client.nextJsonWhere<{ type: string }>((msg) => msg.type === "host-info");

    client.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-all-1", name: "all-one" });
    const ready1 = await client.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-all-1",
    );
    client.sendJson({ type: "input", data: "printf 'all-one\\n'\r" });
    await client.nextBinaryContaining("all-one");

    client.sendJson({ type: "create", cols: 80, rows: 24, requestId: "create-all-2", name: "all-two" });
    const ready2 = await client.nextJsonWhere<{ type: string; id: string }>(
      (msg) => msg.type === "ready" && msg.requestId === "create-all-2",
    );
    client.sendJson({ type: "input", data: "printf 'all-two\\n'\r" });
    await client.nextBinaryContaining("all-two");

    const measure = Bun.spawn([process.execPath, "run", "scripts/measure-session-reconnect.ts", "--all", "ghostty"], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        SERVER_PORT: String(serverPort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(measure.stdout).text();
    const stderr = await new Response(measure.stderr).text();
    await measure.exited;
    expect(measure.exitCode).toBe(0);
    expect(stderr).toBe("");

    const parsed = JSON.parse(stdout) as {
      renderer: string;
      sessionCount: number;
      results: Array<{
        sessionId: string;
        sessionName: string;
        raw: { replayBytesReceived: number };
        snapshot: { backend: string | null; snapshotBytes: number | null };
      }>;
    };

    expect(parsed.renderer).toBe("ghostty");
    expect(parsed.sessionCount).toBeGreaterThanOrEqual(2);
    expect(parsed.results.some((entry) => entry.sessionId === ready1.id && entry.sessionName === "all-one")).toBe(true);
    expect(parsed.results.some((entry) => entry.sessionId === ready2.id && entry.sessionName === "all-two")).toBe(true);
    expect(parsed.results.every((entry) => entry.raw.replayBytesReceived > 0)).toBe(true);
    expect(parsed.results.every((entry) => entry.snapshot.snapshotBytes != null && entry.snapshot.snapshotBytes > 0)).toBe(true);
  } finally {
    client?.close();
    await terminateProcess(server);
    await terminateProcess(ptyd);
  }
}, 60_000);
