# TODO

## Bugs (lower priority)
- [x] `^[[O` / `^[[I` spam — fixed (onData guard + useMemo stable tm ref)
- [x] Kill session uses native `confirm()` — replaced with custom Modal
- [x] Session switch showed blank terminal — fixed
- [x] Sessions die on server hot reload — fixed (globalThis persistence)
- [x] Double cursor when switching — fixed (per-session terminals)
- [x] New session blank until switch away/back — fixed (sessions before ready)
- [x] Session name collisions after delete — fixed (champion name pool)

## Completed features
- [x] React + Vite frontend, Bun WebSocket server
- [x] Per-session xterm.js instances (lazy, WebGL on active only)
- [x] Session persistence — survive tab close, scrollback replay on reconnect
- [x] WebSocket auto-reconnect with status indicator
- [x] Keyboard shortcuts: Alt+T new, Alt+W kill, Alt+1-9 switch
- [x] Custom kill confirmation modal
- [x] Session rename — double-click or right-click → context menu, persisted server-side
- [x] Right-click context menu — Rename / Duplicate / Kill
- [x] Duplicate session — spawns in same CWD, inserted directly after source in list
- [x] Rename UX polish — CWD subtitle stays visible, no height jump (box-shadow not border)
- [x] Champion names for auto-generated session names (all 172, as of Feb 2026)
- [x] Live CWD subtitle in sidebar (Enter-key triggered + 30s fallback poll)
- [x] Client-side session ordering persisted to localStorage
- [x] Dev mode accessible over Tailscale (Vite `host: true`)

## Up next (in order)

1. **E2E test suite (Playwright)** — high priority; project is fully AI-vibe-coded so
   agents need automated regression detection between sessions. Key flows to cover:
   - Session create, switch, scrollback replay (no duplication), kill, rename
   - Reconnect behavior (WS drop + rejoin)
   - Mobile layout (viewport resize, sidebar toggle)
   Strategy: start `bun run dev` as a fixture, drive browser with Playwright,
   read terminal content via `term.buffer.active` exposed through a test hook or
   `page.evaluate`. See `testing.md` (to be created) for architecture.

2. **Long-press context menu on mobile** — touch devices have no right-click;
   need `pointerdown` + 500ms timeout → open context menu at touch position.
   Cancel on `pointerup`/`pointermove`. Replaces the hidden kill button on touch.

3. **URL routing** — `#<id>` hash to deeplink / bookmark directly to a session

## Backlog

- [ ] Multi-machine dashboard — each Tailscale machine runs its own server, one page lists all
- [ ] Auto-update — server polls for new version, restarts itself
- [ ] Custom launch command per session — start directly into `claude`, `ssh host`, etc.
- [ ] Search in scrollback — `xterm-addon-search`
- [ ] Font size adjustment in UI
- [ ] Session pinning
- [ ] Export scrollback as text
- [ ] Tmux session auto-discovery (dev-sessions MCP interop)

## Decisions made

- **Bun native PTY** — `Bun.spawn({ terminal: { ... } })`, no node-pty
- **Per-session xterm.js instances, lazy** — created on first view, kept alive; WebGL on active only
- **`visibility:hidden` not `display:none`** — FitAddon needs layout to measure
- **`attachingIdRef`** — routes binary scrollback to the right terminal before `ready` arrives
- **`globalThis` for session Map** — survives Bun `--hot` reloads
- **Binary WS frames** for terminal output, JSON for control
- **No tmux** — PTY owned directly
- **Alt+modifier** shortcuts — Cmd+T/W reserved by browser
- **Champion names** — memorable, unique, no collisions after delete
- **Client-side ordering** — display preference only, localStorage; server order irrelevant
- **OSC title auto-naming** — deliberately skipped; would conflict with champion names + CWD subtitle
