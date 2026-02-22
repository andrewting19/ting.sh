# TODO

## Bugs (lower priority)
- [x] `^[[O` / `^[[I` spam — fixed (onData guard + useMemo stable tm ref)
- [x] Kill session uses native `confirm()` — replaced with custom Modal
- [x] Session switch showed blank terminal — fixed
- [x] Sessions die on server hot reload — fixed (globalThis persistence)
- [x] Double cursor when switching — fixed (per-session terminals)
- [x] New session blank until switch away/back — fixed (sessions before ready)
- [x] Session name collisions after delete — fixed (champion name pool)
- [x] Shared-session width stuck after phone use — fixed (foreground + same-session resize reclaim)
- [x] Output leaked into wrong terminal during fast session switches — fixed (requestId-validated attach + stale-stream binary quarantine)
- [x] Truncated replay could render with broken ANSI state — fixed (sanitize first partial line after buffer cap trims)
- [x] Duplicate output after reconnect/hot reload — fixed (ignore stale WS events + hot-reload regression test)
- [x] Host-scoped drag reorder intermittently no-op'd — fixed (read dragged host from live ref inside drag handlers + reorder persistence regression test)
- [x] Cross-site WS hijack risk — fixed (`/ws` now rejects mismatched `Origin`, allows absent origin for non-browser clients)
- [x] Peer host stayed stuck on `reconnecting` — fixed (`/ws` Origin check now trusts configured peer origins, not strict same-origin only)
- [x] Local host stayed hardcoded as `local` — fixed (reconcile local host id/name from `host-info` and `/api/host`)
- [x] Peer WS scheme inherited from page protocol — fixed (derive ws/wss from each host URL instead)
- [x] Deprecated `useWS` hook still present — fixed (remove dead hook and keep WS lifecycle in `useHostConnections`)
- [x] `server.ts` control-path `any` usage — fixed (typed JSON guards + typed field coercion helpers)
- [x] Dev mode could leave Vite up with a dead WS backend — fixed (`bun run dev` now uses `concurrently -k` to fail fast when either process exits)

## Completed features
- [x] React + Vite frontend, Bun WebSocket server
- [x] Per-session xterm.js instances (lazy, WebGL on active only)
- [x] Session persistence — survive tab close, scrollback replay on reconnect
- [x] WebSocket auto-reconnect with status indicator
- [x] Keyboard shortcuts: Alt+T new, Alt+W kill, Alt+1-9 switch on active host
- [x] Custom kill confirmation modal
- [x] Session rename — double-click or right-click → context menu, persisted server-side
- [x] Right-click context menu — Rename / Duplicate / Kill
- [x] Duplicate session — spawns in same CWD, inserted directly after source in list
- [x] Rename UX polish — CWD subtitle stays visible, no height jump (box-shadow not border)
- [x] Champion names for auto-generated session names (all 172, as of Feb 2026)
- [x] Live CWD subtitle in sidebar (Enter-key triggered + 30s fallback poll)
- [x] Client-side session ordering persisted to per-host localStorage keys
- [x] Dev mode accessible over Tailscale (Vite `host: true`)

## Completed features (continued)
- [x] E2E test suite (Playwright) — 28 tests covering all key flows
- [x] Long-press context menu on mobile (pointerdown + 500ms, click suppression)
- [x] Drag-to-end (sentinel drop zone after last session item)
- [x] URL hash routing — `#<hostId>/<name>` deeplinks to session by host + name (legacy `#<name>` supported for local host)
- [x] Auto-attach to first session when no hash in URL
- [x] Kill-to-next — killing current session auto-navigates to nearest surviving session
- [x] primeTerminal — xterm.js instance created before container div exists so startup output buffers
- [x] Mobile toolbar — keyboard button, scroll-to-bottom, ESC, Enter, arrow pad, sticky CTRL/SHIFT, 3 programmable hotkeys, paste modal with history
- [x] Mobile toolbar polish — hotkey editor key-type switching fixed, ALT hotkey sequences, mutually exclusive toolbar overlays
- [x] iOS tap-to-keyboard disabled on terminal canvas; keyboard via toolbar button only
- [x] iOS Safari scroll-on-text bug fixed (Canvas renderer forced on iOS + renderer guard test)
- [x] Shared-session resize reclaim — active session click/foreground reapplies local PTY dimensions
- [x] Manual multi-host production verification (two real servers) — create/attach/input/kill/offline-reconnect validated end-to-end

## Up next (in order)
- [x] Multi-host phase 1: protocol hardening (`detach`, list subscribers, `requestId` echo)
- [x] Multi-host phase 2: server identity (`hosts.json`, `/api/host`, `host-info`, `hostId`)
- [x] Multi-host phase 3: shared types (`Host`, `SessionKey`, host-aware `Session`)
- [x] Multi-host phase 4: `useHostConnections` hook
- [x] Multi-host phase 5: app + terminal manager host-aware refactor
- [x] Multi-host phase 6: host-grouped sidebar UI
- [x] Multi-host phase 7: polish (hash routing, host-local ordering, host shortcuts)

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
- **Attach correlation via `requestId`** — client validates `ready` against the latest attach request and drops stale attach binary to prevent cross-session replay leaks
- **`globalThis` for session Map** — survives Bun `--hot` reloads
- **Binary WS frames** for terminal output, JSON for control
- **No tmux** — PTY owned directly
- **Alt+modifier** shortcuts — Cmd+T/W reserved by browser
- **Champion names** — memorable, unique, no collisions after delete
- **Client-side ordering** — display preference only, localStorage; server order irrelevant
- **OSC title auto-naming** — deliberately skipped; would conflict with champion names + CWD subtitle
