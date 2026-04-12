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
            └─ tests/renderer-matrix.pw.ts (shared core flows under xterm + ghostty)
            └─ tests/session.pw.ts   (all E2E tests)
            └─ tests/helpers.ts      (shared utilities)
```

- `e2e.test.ts` allocates three free OS ports via `Bun.serve({ port: 0 })`, then spawns Playwright as a subprocess with `TEST_VITE_PORT`, `TEST_WS_PORT`, and `TEST_PTYD_PORT`.
- `playwright.config.ts` requires those env vars and starts the Vite dev server, Bun WS backend, and `ptyd` sidecar on those dynamic ports. There is intentionally no fallback to default ports, so test runs cannot drift onto a live ting.sh instance.
- The test server uses `SHELL=/bin/bash` so tests don't depend on the user's `.zshrc` (interactive zsh can hang on slow plugins/DNS).
- `.pw.ts` extension keeps Playwright tests invisible to Bun's test scanner.

## Concurrency safety

Each `bun test` run gets its own unique port pair from the OS. Multiple coding agents can run tests simultaneously without collisions. No port-killing or cleanup is needed between runs.

## Key helpers (`tests/helpers.ts`)

| Helper | What it does |
|---|---|
| `newSession(page)` | Clicks "+ new", waits for a new `[data-session-id]` to appear, returns its ID. Tolerates leftover sessions (diffs before/after). |
| `loadWithRenderer(page, renderer)` | Boots the app under `xterm` or `ghostty` by seeding localStorage before navigation, then kills leftover sessions. |
| `getActiveRenderer(page)` | Reads the currently booted renderer from the dev helper / document dataset. |
| `waitForPrompt(page, id, timeout?)` | Polls the backend-neutral dev helper via `window.__wt_terminal_debug` until any non-whitespace line appears. Includes diagnostics on timeout. |
| `waitForTerminal(page, id, needle, timeout?)` | Polls until `needle` string appears in the terminal buffer. |
| `killAllSessions(page)` | Waits for WS connected + stable session count, then kills sessions **sequentially** (kill one, wait for DOM removal, repeat). |
| `getSessions(page)` | Returns all `[data-session-id]` values currently in the DOM. |
| `switchToSession(page, id)` | Clicks the sidebar item for the given session ID. |
| `getTerminalText(page, id)` | Reads terminal text via `window.__wt_terminal_debug`. |

## Dev-mode test hooks on `window`

The app exposes these in dev mode (`import.meta.env.DEV`) for test use:

- `__wt_terminal_debug` — dev helper for backend-neutral terminal text and scroll state used by E2E tests.
- `__wt_terminal_debug.getRenderer()` — returns the active renderer (`xterm` or `ghostty`) in dev mode.
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

6. **Terminal content is read via `__wt_terminal_debug`, not the DOM.** Terminal renderers may use canvas or other non-text DOM, so the `getTerminalText` and `waitForTerminal` helpers read from the app's dev helper instead of scraping UI output.

7. **Don't use `page.context().setOffline(true)` for WS disconnect tests.** It doesn't reliably affect localhost WebSocket connections. Use `__wt_ws_close()` instead.

8. **Tests run with `/bin/bash`, not the user's shell.** Don't assert zsh-specific prompt strings (like `%`). The `waitForPrompt` helper just checks for any non-whitespace output.

9. **Test timeout is 15 seconds.** If a test needs longer, something is wrong. Individual `waitFor*` calls should use explicit timeouts (3-8s) rather than relying on the global timeout.

10. **Prefer the renderer matrix for shared behavior.** Put parity-sensitive core flows in `tests/renderer-matrix.pw.ts` and run them for both `xterm` and `ghostty`. Keep `tests/session.pw.ts` for broader app coverage and renderer-specific expectations that are not yet matrix-ready.

11. **Use browser-use as a final smoke pass for renderer work.** After large renderer or lifecycle changes, exercise at least create, input, session switch, and reload manually under both `xterm` and `ghostty` against the live dev server.

## Gotchas

- **React StrictMode double-mount**: The app uses StrictMode, so effects run twice in dev. The host connection manager's `WSConnection` cleanup guards prevent orphaned reconnect timers/sockets from the first mount.

- **Binary routing**: PTY output is routed to `attachingIdRef.current ?? currentIdRef.current`. After `killAllSessions`, if `currentIdRef` still points to a dead session, new session output goes to the wrong terminal. The sequential kill approach avoids this by letting each `session-exit` handler clean up refs before the next kill.

- **`hasHandledInitialHashRef`**: On first page load with existing sessions, the app auto-attaches to the first session (or the hash-matched one). This fires once. Tests that need a specific session to be "first" should `killAllSessions` first (which `beforeEach` already does).
