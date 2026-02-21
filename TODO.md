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

## Completed features (continued)
- [x] E2E test suite (Playwright) — 23 tests covering all key flows
- [x] Long-press context menu on mobile (pointerdown + 500ms, click suppression)
- [x] Drag-to-end (sentinel drop zone after last session item)
- [x] URL hash routing — `#<name>` deeplinks to session by name
- [x] Auto-attach to first session when no hash in URL
- [x] Kill-to-next — killing current session auto-navigates to nearest surviving session
- [x] primeTerminal — xterm.js instance created before container div exists so startup output buffers
- [x] Mobile toolbar — keyboard button, scroll-to-bottom, ESC, Enter, arrow pad, sticky CTRL/SHIFT, 3 programmable hotkeys, paste modal with history
- [x] Mobile toolbar polish — hotkey editor key-type switching fixed, ALT hotkey sequences, mutually exclusive toolbar overlays
- [x] iOS tap-to-keyboard disabled on terminal canvas; keyboard via toolbar button only
- [x] iOS Safari scroll-on-text bug fixed (Canvas renderer forced on iOS + renderer guard test)

## Up next (in order)

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
- **Renderer split by platform** — WebGL on desktop; Canvas forced on iOS to avoid Safari glyph-touch selection issues
- **`visibility:hidden` not `display:none`** — FitAddon needs layout to measure
- **`attachingIdRef`** — routes binary scrollback to the right terminal before `ready` arrives
- **`globalThis` for session Map** — survives Bun `--hot` reloads
- **Binary WS frames** for terminal output, JSON for control
- **No tmux** — PTY owned directly
- **Alt+modifier** shortcuts — Cmd+T/W reserved by browser
- **Champion names** — memorable, unique, no collisions after delete
- **Client-side ordering** — display preference only, localStorage; server order irrelevant
- **OSC title auto-naming** — deliberately skipped; would conflict with champion names + CWD subtitle
