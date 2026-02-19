# TODO

## 🔴 Critical bugs (fix first)

- [x] **`^[[O` spam filling terminal** — Fixed: guard in `useTerminalManager.ts` `onData` callback ensures only the active terminal's input is forwarded to the PTY.

## Bugs (lower priority)
- [x] `^[[I%` artifact on new session — fixed
- [x] Kill session uses native `confirm()` — replaced with custom Modal component
- [x] Session switch showed blank terminal — fixed (reset before attach, not after ready)
- [x] Sessions die on server hot reload — fixed (globalThis persistence)
- [x] Double cursor when switching from Claude Code — fixed (per-session terminals)

## Completed features
- [x] React + Vite migration
- [x] Per-session xterm.js instances (lazy — created on first view)
- [x] WebGL renderer on active terminal only, disposed when switching
- [x] Keyboard shortcuts: Alt+T new, Alt+W kill, Alt+1-9 switch
- [x] Custom kill confirmation modal
- [x] Inline session rename (double-click, persisted on server)
- [x] WebSocket auto-reconnect with status indicator
- [x] 10MB scrollback buffer per session, replayed on reconnect

## Up next (in order)

1. **OSC title auto-naming** — intercept `OSC 0` / `OSC 2` escape sequences from PTY output to auto-update session name. Claude Code, vim, ssh all set this.
2. **Copy-on-select** — xterm.js `copyOnSelect` option
3. **URL routing** — `/?s=<id>` to link/bookmark directly to a session

## Completed features (recent)
- [x] Live CWD subtitle in sidebar (Enter-key triggered + 30s fallback poll)

## Backlog

- [ ] Multi-machine dashboard — each Tailscale machine runs its own server, one page lists all. User configures machine list with Tailscale IPs/ports.
- [ ] Auto-update — server polls for new version, restarts itself
- [ ] Custom command on session create — launch directly into `claude`, `ssh host`, etc.
- [ ] Search in scrollback — `xterm-addon-search`
- [ ] Font size adjustment in UI
- [ ] Session pinning
- [ ] Export scrollback as text
- [ ] Tmux session auto-discovery by prefix (dev-sessions MCP interop)

## Ideas / future scope

### Multiplayer
Sessions already broadcast to N clients. Future roles:
- `owner` — full PTY control
- `collaborator` — can type (pair programming)
- `viewer` — read-only
- `suggester` — read-only + suggestion queue for owner to approve

Access via invite links: `/join/<token>` with role baked in.

## Decisions made

- **Bun native PTY** — `Bun.spawn({ terminal: { ... } })`, no node-pty needed
- **Per-session xterm.js instances, lazy** — created on first view, kept alive. WebGL only on active terminal. Scales to many sessions with minimal overhead.
- **`visibility:hidden` not `display:none`** for inactive terminals — keeps them in layout so FitAddon can measure dimensions before activation
- **`attachingIdRef`** — tracks the session we're transitioning to so binary scrollback (arrives before `ready`) routes to the correct terminal
- **`globalThis` for session Map** — survives Bun `--hot` module reloads, sessions persist across server file changes in dev
- **Binary WS frames** for terminal output, JSON for control messages
- **No tmux dependency** — PTY owned directly
- **Alt+modifier** for shortcuts — Cmd+T/W are reserved by Chrome
