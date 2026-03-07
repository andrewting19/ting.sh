# Claude agent instructions

## Stack

- **Runtime**: Bun 1.3.6+
- **Backend**: `server.ts` — Bun HTTP + WebSocket server, `Bun.spawn` PTY on Unix/macOS, `node-pty` ConPTY worker on Windows
- **Frontend**: React 18 + TypeScript, bundled by Vite
- **Terminal renderer**: xterm.js 5.x with WebGL addon + FitAddon
- **Styling**: Plain CSS with CSS variables in `src/App.css` — no CSS framework

## Dev workflow

```bash
bun run dev      # Vite on :4321 (HMR) + WS server on :7681
bun run build    # Vite build → dist/
bun run start    # Production: Bun serves dist/ + WS on :7681
bun run release  # Bump patch, build, tag, push, publish GitHub release
```

In dev, Vite proxies `/ws` and `/api` to `localhost:7681`. The frontend always connects to `ws://${location.host}/ws` so the same URL works in both dev and prod.

## After every meaningful change

1. **Commit** with a descriptive message (see standard below)
2. **Update README.md** "Current state" section if working/missing features changed
3. **Update TODO.md** — check off completed items, add newly discovered bugs or tasks

## When to run tests

Run `bun test` **after every commit**. Tests take ~10 seconds. If tests fail, fix and recommit before moving on.

Playwright test files use the `.pw.ts` extension so Bun's scanner ignores them; `tests/e2e.test.ts` is the entry point Bun discovers and it spawns Playwright as a subprocess. Each run gets OS-assigned dynamic ports so concurrent agents never collide.

E2E tests are the primary suite. Unit tests are welcome for pure logic (server session management, name allocation, state machines) — add them as `*.test.ts` files alongside the code they test. Don't unit-test React/WS/xterm.js integration — E2E covers that better.

See `tests/CLAUDE.md` for detailed test architecture and guidelines for writing new tests.

These three steps keep the repo self-documenting so any future developer (or Claude session) can onboard from the files alone.

## Commit message standard

Every commit needs a subject line and a body. No exceptions.

```
imperative subject line, 50 chars max

- What changed and why
- Any trade-offs or alternatives considered
- Reference prior state if it helps explain the decision

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
```

Good subject lines: `fix cursor hidden after session switch`, `add kill session confirmation modal`, `migrate frontend to React + Vite`

Bad subject lines: `fix bug`, `update`, `wip`

The git log is the project history. `git log --oneline` should read like a changelog.

## Code conventions

- TypeScript everywhere — no `any` unless truly unavoidable, add a comment if you use it
- No external state libraries — React `useState`/`useRef`/`useReducer` is enough for now
- xterm.js Terminal instance lives in a `useRef`, never in React state — it must not re-render
- WebSocket connections managed by `useHostConnections` hook (imperative `WSConnection` per host)
- CSS variables for all colors/sizes — defined in `src/App.css`, never hardcode hex values in components
- Prefer editing existing files over creating new ones

## Architecture notes

- `server.ts` — single file, session Map, Bun WebSocket handler. Keep it simple.
- `src/hooks/useHostConnections.ts` — manages per-host WS lifecycle, auto-reconnect, imperative `WSConnection` class
- `src/hooks/useTerminalManager.ts` — owns all xterm.js instances; exposes `primeTerminal`, `ensureTerminal`, `write`, `reset`, `setActive`, `focus`, `getDimensions`, `destroy`
- Binary WS frames = raw PTY output → `term.write(data)`. JSON frames = control messages.
- Sessions survive tab close. Scrollback buffer (10MB cap) replayed on reconnect.
- **Scrollback**: server always replays the full buffer on every `attach`. Client must call `tm.reset(id)` before sending `attach` to avoid duplication on re-attach. `fresh` flag in `ready` is only set for `create`, not `attach` — it's informational only now.
- **`primeTerminal`**: called from the `ready` handler (for `create`) before React has rendered the container div. Creates the xterm.js Terminal instance in a not-yet-opened state so PTY output that arrives during the React render cycle is buffered rather than dropped. `ensureTerminal` detects the primed state and calls `term.open(container)` when the div is available.
- **`attachSession` order matters**: `ensureTerminal` → `reset` → `setCurrentId` (optimistic) → `setActive` → `focus` → `send attach`. Focus must be called synchronously within the user gesture for iOS keyboard to appear.

## Deployment

- **Production**: systemd service (`deploy/ting-sh.service`) runs `bun run server.ts` from `/opt/ting.sh/`
- **Install**: `deploy/install.sh` — installs Bun, downloads latest GitHub release tarball, sets up systemd
- **Release**: `scripts/release.sh` — bumps `VERSION`, builds, creates tarball, tags, publishes via `gh release create`
- **Auto-update**: server polls GitHub releases API every 5min, downloads new tarball, extracts in-place, `process.exit(0)` for systemd restart. Disable with `AUTO_UPDATE=false`.
- **Config**: `hosts.json` at server root (gitignored, machine-specific). `HOSTS_FILE=none` env var skips loading (used in tests).
- **CSWSH**: `/ws` Origin check trusts same-origin, peer hostnames (any port), and localhost/127.0.0.1.

## Mobile / CSS patterns

- **Never use `display:none` for inactive terminal panes** — FitAddon can't measure. Use `opacity: 0; pointer-events: none`.
- **Never use `visibility: hidden` for focusable elements** — iOS Safari won't trigger keyboard from elements inside `visibility: hidden` containers. Use `opacity: 0` instead.
- **Always wrap hover styles in `@media (hover: hover)`** — touch devices fire `:hover` on first tap, causing double-tap to select. Pattern:
  ```css
  @media (hover: hover) {
    .thing:hover { background: var(--bg2); }
  }
  ```
- **Use `100dvh` not `100vh`** — iOS Safari's `100vh` ignores the collapsible browser chrome. Always set both: `height: 100vh; height: 100dvh;`
- **Grid + `position: fixed` children**: fixed elements don't block grid auto-placement. Give `.main` explicit `grid-column: 2; grid-row: 2` so it doesn't collapse to the 0px sidebar column on mobile.
- **WebGL on mobile**: skip it — fails silently on iOS Safari. Detect with `navigator.userAgent` and fall through to canvas renderer.
- **Long-press for context menu on touch**: use `pointerdown` + 500ms timeout, cancel on `pointerup`/`pointermove`. Right-click doesn't exist on touch devices.
