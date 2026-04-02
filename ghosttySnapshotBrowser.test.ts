import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { XtermVtSnapshotTracker } from "./src/snapshot/xtermVtSnapshot";

interface BufferState {
  type: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  lines: string[];
}

interface TerminalState {
  activeType: "normal" | "alternate";
  normal: BufferState;
  alternate: BufferState;
}

function snapshotBuffer(buffer: XtermVtSnapshotTracker["terminal"]["buffer"]["active"]): BufferState {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return {
    type: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    lines,
  };
}

function snapshotTerminal(term: XtermVtSnapshotTracker["terminal"]): TerminalState {
  return {
    activeType: term.buffer.active.type,
    normal: snapshotBuffer(term.buffer.normal),
    alternate: snapshotBuffer(term.buffer.alternate),
  };
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  await server.stop();
  return port;
}

test("ghostty restores visible xterm snapshot state but not full normal-buffer semantics", async () => {
  const source = new XtermVtSnapshotTracker(32, 8, 200);
  await source.write("normal-1\r\nnormal-2\r\nnormal-3\r\nnormal-4\r\nnormal-5\r\nnormal-6\r\nnormal-7\r\nnormal-8\r\nnormal-9\r\n");
  await source.write("\x1b[?1049h");
  await source.write("\x1b[2J\x1b[H");
  await source.write("ALT HEADER\r\n");
  await source.write("status: running");
  await source.write("\x1b[4;6Hcursor-here");

  const snapshot = source.capture();
  const expected = snapshotTerminal(source.terminal);
  const port = await getFreePort();
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(`<!doctype html>
<html>
  <body>
    <div id="terminal" style="width: 640px; height: 240px;"></div>
    <script>window.__SNAPSHOT__ = ${JSON.stringify(snapshot)};</script>
    <script type="module" src="/app.js"></script>
  </body>
</html>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/app.js") {
        return new Response(`
          import { init, Terminal } from "/ghostty-web.js";

          function snapshotBuffer(buffer) {
            const lines = [];
            for (let i = 0; i < buffer.length; i += 1) {
              const line = buffer.getLine(i);
              lines.push(line ? line.translateToString(true) : "");
            }
            return {
              type: buffer.type,
              cursorX: buffer.cursorX,
              cursorY: buffer.cursorY,
              baseY: buffer.baseY,
              viewportY: buffer.viewportY,
              lines,
            };
          }

          const snapshot = window.__SNAPSHOT__;
          await init();
          const term = new Terminal({ cols: snapshot.cols, rows: snapshot.rows });
          term.open(document.getElementById("terminal"));
          await new Promise((resolve) => term.write(snapshot.payload, resolve));
          window.__STATE__ = {
            activeType: term.buffer.active.type,
            normal: snapshotBuffer(term.buffer.normal),
            alternate: snapshotBuffer(term.buffer.alternate),
          };
        `, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }

      if (url.pathname === "/ghostty-web.js") {
        return new Response(Bun.file("./node_modules/@andrewting19/ghostty-web/dist/ghostty-web.js"), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }

      if (url.pathname === "/ghostty-vt.wasm") {
        return new Response(Bun.file("./node_modules/@andrewting19/ghostty-web/ghostty-vt.wasm"), {
          headers: { "content-type": "application/wasm" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as Window & { __STATE__?: unknown }).__STATE__));
    const actual = await page.evaluate(() => (window as Window & { __STATE__: TerminalState }).__STATE__);
    expect(actual.activeType).toBe(expected.activeType);
    expect(actual.alternate).not.toEqual(expected.alternate);
    expect(actual.alternate.lines.some((line) => line.includes("ALT HEADER"))).toBe(true);
    expect(actual.alternate.lines.some((line) => line.includes("status: running"))).toBe(true);
    expect(actual.alternate.lines.some((line) => line.includes("cursor-here"))).toBe(true);
    expect(actual.normal).not.toEqual(expected.normal);
    expect(actual.normal.lines.some((line) => line.includes("normal-9"))).toBe(false);
  } finally {
    await browser.close();
    await server.stop();
  }
}, 60_000);
