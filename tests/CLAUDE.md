# Test suite — agent instructions

## When to add unit tests vs E2E

- **E2E** (Playwright): anything involving the full stack — UI interactions, WS message flow, terminal rendering, session lifecycle. This is the primary suite.
- **Unit tests** (Bun): pure logic that can be tested in isolation — server session management, name allocation, state machine helpers. Add as `*.test.ts` files alongside the code they test (e.g. `server.test.ts`). Bun's test runner picks these up automatically.
- **Don't unit-test**: React component rendering, WS hookups, xterm.js integration — E2E covers these better with less mocking.

## Architecture

```
bun test
  └─ tests/e2e.test.ts        (Bun test runner entry point)
       └─ playwright test
            └─ tests/session.pw.ts   (all E2E tests)
            └─ tests/helpers.ts      (shared utilities)
```

- `e2e.test.ts` allocates two free OS ports via `Bun.serve({ port: 0 })`, then spawns Playwright as a subprocess with `TEST_VITE_PORT` and `TEST_WS_PORT` env vars.
- `playwright.config.ts` reads those env vars to start the Vite dev server and Bun WS backend on the dynamic ports. Fallback to 4322/7682 if env vars are missing (for direct `playwright test` debugging).
- The test server uses `SHELL=/bin/bash` so tests don't depend on the user's `.zshrc` (interactive zsh can hang on slow plugins/DNS).
- `.pw.ts` extension keeps Playwright tests invisible to Bun's test scanner.

## Concurrency safety

Each `bun test` run gets its own unique port pair from the OS. Multiple coding agents can run tests simultaneously without collisions. No port-killing or cleanup is needed between runs.

## Key helpers (`tests/helpers.ts`)

| Helper | What it does |
|---|---|
| `newSession(page)` | Clicks "+ new", waits for a new `[data-session-id]` to appear, returns its ID. Tolerates leftover sessions (diffs before/after). |
| `waitForPrompt(page, id, timeout?)` | Polls the xterm.js buffer via `window.__wt_terminals` until any non-whitespace line appears. Includes diagnostics on timeout. |
| `waitForTerminal(page, id, needle, timeout?)` | Polls until `needle` string appears in the terminal buffer. |
| `killAllSessions(page)` | Waits for WS connected + stable session count, then kills sessions **sequentially** (kill one, wait for DOM removal, repeat). |
| `getSessions(page)` | Returns all `[data-session-id]` values currently in the DOM. |
| `switchToSession(page, id)` | Clicks the sidebar item for the given session ID. |
| `getTerminalText(page, id)` | Reads the full xterm.js buffer content via `window.__wt_terminals`. |

## Dev-mode test hooks on `window`

The app exposes these in dev mode (`import.meta.env.DEV`) for test use:

- `__wt_terminals` — `Map<sessionId, { term, opened }>` — direct access to xterm.js Terminal instances and their buffers.
- `__wt_send` — `(obj: object) => void` — send arbitrary WS messages (e.g. `{ type: 'kill', id }`).
- `__wt_ws_close` — `() => void` — force-close the WS connection (used by the reconnect test since `setOffline(true)` doesn't affect localhost).

## Writing a new test

### Template

```typescript
test('descriptive name — what is being verified', async ({ page }) => {
  // beforeEach already navigated to '/' and killed all sessions.
  // You start with a clean slate: WS connected, zero sessions.

  const id = await newSession(page)
  await waitForPrompt(page, id)

  // ... interact with the page ...

  // Assert using Playwright's built-in expect with timeouts
  await expect(page.locator('.some-element')).toBeVisible({ timeout: 3000 })
})
```

### Guidelines

1. **Always use `waitForPrompt` after `newSession`** if you need the shell to be ready before interacting. Without it, keyboard input may arrive before the shell is listening.

2. **Never use arbitrary sleeps.** Use `waitForFunction`, `waitForSelector`, or Playwright's `expect().toBeVisible/toHaveText` with timeouts instead.

3. **Use `waitForTerminal(page, id, needle)` to assert terminal content**, not `getTerminalText` with immediate assertions. Terminal output is async.

4. **The `beforeEach` kills all sessions.** Every test starts from zero sessions. Don't worry about cleanup — the next test's `beforeEach` handles it.

5. **`killAllSessions` is sequential, not bulk.** Bulk-killing causes an auto-attach cascade where killing the current session triggers `attachSession` to the next one, which may already be dead server-side. Sequential kill-and-wait avoids this.

6. **Terminal content is read via `__wt_terminals`, not the DOM.** xterm.js renders to canvas, so DOM text queries don't work. The `getTerminalText` and `waitForTerminal` helpers read from the xterm.js buffer API.

7. **Don't use `page.context().setOffline(true)` for WS disconnect tests.** It doesn't reliably affect localhost WebSocket connections. Use `__wt_ws_close()` instead.

8. **Tests run with `/bin/bash`, not the user's shell.** Don't assert zsh-specific prompt strings (like `%`). The `waitForPrompt` helper just checks for any non-whitespace output.

9. **Test timeout is 15 seconds.** If a test needs longer, something is wrong. Individual `waitFor*` calls should use explicit timeouts (3-8s) rather than relying on the global timeout.

## Gotchas

- **React StrictMode double-mount**: The app uses StrictMode, so effects run twice in dev. The host connection manager's `WSConnection` cleanup guards prevent orphaned reconnect timers/sockets from the first mount.

- **Binary routing**: PTY output is routed to `attachingIdRef.current ?? currentIdRef.current`. After `killAllSessions`, if `currentIdRef` still points to a dead session, new session output goes to the wrong terminal. The sequential kill approach avoids this by letting each `session-exit` handler clean up refs before the next kill.

- **`hasHandledInitialHashRef`**: On first page load with existing sessions, the app auto-attaches to the first session (or the hash-matched one). This fires once. Tests that need a specific session to be "first" should `killAllSessions` first (which `beforeEach` already does).
