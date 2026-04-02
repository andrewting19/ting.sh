import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { XtermVtSnapshotTracker } from "./src/snapshot/xtermVtSnapshot";
import { captureCanonicalTerminalSnapshot } from "./src/snapshot/canonicalSnapshot";
import { captureRenderedTextSnapshot, renderedTextSnapshotToVt } from "./src/snapshot/renderedTextSnapshot";

interface GhosttySemanticState {
  scrollbackLength: number;
  scrollbackLines: string[];
  viewportLines: string[];
  viewportY: number;
}

function logicalLines(lines: Array<{ text: string; wrapped: boolean }>): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    current += line.text;
    if (line.wrapped) continue;
    out.push(current);
    current = "";
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  await server.stop();
  return port;
}

test("ghostty rendered-text VT restore preserves semantic normal scrollback", async () => {
  const source = new XtermVtSnapshotTracker(32, 8, 200);
  await source.write("normal-1\r\nnormal-2\r\nnormal-3\r\nnormal-4\r\nnormal-5\r\nnormal-6\r\nnormal-7\r\nnormal-8\r\nnormal-9\r\n");

  const canonical = captureCanonicalTerminalSnapshot(source.terminal);
  const renderedSnapshot = captureRenderedTextSnapshot(source.terminal);
  const renderedVt = renderedTextSnapshotToVt(renderedSnapshot);
  const expectedLogical = logicalLines(canonical.normal.lines);
  const expectedScrollback = expectedLogical.slice(0, -canonical.rows);
  const expectedViewport = expectedLogical.slice(-canonical.rows);
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
    <script>window.__SNAPSHOT__ = ${JSON.stringify({ cols: renderedSnapshot.cols, rows: renderedSnapshot.rows, payload: renderedVt })};</script>
    <script type="module" src="/app.js"></script>
  </body>
</html>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/app.js") {
        return new Response(`
          import { init, Terminal } from "/ghostty-web.js";

          function lineToString(cells) {
            return (cells ?? []).map((cell) => {
              if (!cell || cell.codepoint === 0) return "";
              return String.fromCodePoint(cell.codepoint);
            }).join("").trimEnd();
          }

          const snapshot = window.__SNAPSHOT__;
          await init();
          const term = new Terminal({ cols: snapshot.cols, rows: snapshot.rows });
          term.open(document.getElementById("terminal"));
          await new Promise((resolve) => term.write(snapshot.payload, resolve));
          const scrollbackLength = term.getScrollbackLength();
          const scrollbackLines = [];
          for (let i = 0; i < scrollbackLength; i += 1) {
            scrollbackLines.push(lineToString(term.getScrollbackLine(i)));
          }
          const viewportLines = [];
          for (let i = 0; i < term.buffer.normal.length; i += 1) {
            viewportLines.push(term.buffer.normal.getLine(i)?.translateToString(true) ?? "");
          }
          window.__STATE__ = {
            scrollbackLength,
            scrollbackLines,
            viewportLines,
            viewportY: term.getViewportY(),
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
    const actual = await page.evaluate(() => (window as Window & { __STATE__: GhosttySemanticState }).__STATE__);
    expect(actual.scrollbackLength).toBe(expectedScrollback.length);
    expect(actual.scrollbackLines).toEqual(expectedScrollback);
    expect(actual.viewportLines).toEqual(canonical.normal.lines.map((line) => line.text));
    expect(actual.viewportY).toBe(0);
  } finally {
    await browser.close();
    await server.stop();
  }
}, 60_000);
