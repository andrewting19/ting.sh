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
- `fresh: true` in server's `ready` response means it's a newly created session (not an existing one being reattached) — client uses this to know it's safe to `term.reset()` without losing scrollback.
