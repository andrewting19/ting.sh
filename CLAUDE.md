# Claude agent instructions

## Stack

- **Runtime**: Bun 1.3.6+
- **Backend**: `server.ts` — Bun HTTP + WebSocket server, `Bun.spawn` native PTY API (no node-pty)
- **Frontend**: React 18 + TypeScript, bundled by Vite
- **Terminal renderer**: xterm.js 5.x with WebGL addon + FitAddon
- **Styling**: Plain CSS with CSS variables in `src/App.css` — no CSS framework

## Dev workflow

```bash
bun run dev      # Vite on :4321 (HMR) + WS server on :7681
bun run build    # Vite build → dist/
bun run start    # Production: Bun serves dist/ + WS on :7681
```

In dev, Vite proxies `/ws` to `localhost:7681`. The frontend always connects to `ws://${location.host}/ws` so the same URL works in both dev and prod.

## After every meaningful change

1. **Commit** with a descriptive message (see standard below)
2. **Update README.md** "Current state" section if working/missing features changed
3. **Update TODO.md** — check off completed items, add newly discovered bugs or tasks

## When to run tests

**Speed of iteration is the priority. Never let tests block commits.**

Run `bun test` only when:
- End of a session (final sanity check before handing off)
- You modified any file in `tests/`
- You touched a core flow that has test coverage (session switch, kill, rename, reconnect, duplicate)

Do NOT run tests after every commit — commit first, iterate fast, test at the end.

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
- WebSocket instance lives in a `useRef` inside `useWS` hook, same reason
- CSS variables for all colors/sizes — defined in `src/App.css`, never hardcode hex values in components
- Prefer editing existing files over creating new ones

## Architecture notes

- `server.ts` — single file, session Map, Bun WebSocket handler. Keep it simple.
- `src/hooks/useWS.ts` — manages WS lifecycle, auto-reconnect, stable `send` ref
- `src/components/Terminal.tsx` — thin wrapper around xterm.js, exposes imperative handle via `forwardRef`
- Binary WS frames = raw PTY output → `term.write(data)`. JSON frames = control messages.
- Sessions survive tab close. Scrollback buffer (10MB cap) replayed on reconnect.
- **Scrollback**: server always replays the full buffer on every `attach`. Client must call `tm.reset(id)` before sending `attach` to avoid duplication on re-attach. `fresh` flag in `ready` is only set for `create`, not `attach` — it's informational only now.
- **`attachSession` order matters**: `ensureTerminal` → `reset` → `setCurrentId` (optimistic) → `setActive` → `focus` → `send attach`. Focus must be called synchronously within the user gesture for iOS keyboard to appear.

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
