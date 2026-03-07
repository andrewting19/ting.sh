# TODO

## Bugs (lower priority)
- [ ] Optional TUI compatibility mode: ignore ANSI clear-scrollback (`CSI 3J` / `ESC[3J`) for apps like Claude Code that sometimes emit full redraw frames in the normal buffer (`2J` + `3J` + `H`), which collapses xterm scrollback and looks like a flickering scroll-jump bug; prefer xterm parser hook (`parser.registerCsiHandler` for `CSI J` param `3`) and keep it opt-in because `clear`/`reset` semantics change
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
- [x] Mobile D-pad arrows sent wrong sequence in app-cursor mode TUIs — fixed (read xterm `applicationCursorKeysMode` and emit `ESC O*` when needed)
- [x] Mobile keyboard covered terminal bottom + toolbar while typing — fixed (VisualViewport keyboard inset drives terminal/toolbar/overlay bottom offsets)
- [x] Mobile paste/hotkey inputs zoomed page on focus (iOS) — fixed (mobile form control font size raised to 16px in toolbar modals)
- [x] iOS mobile paste sheet focus was delayed (keyboard often stayed closed) and ⌨ toolbar button could still zoom page — fixed (immediate paste autofocus + mobile 16px override for xterm helper textarea, with selector-specificity hardening)
- [x] iOS canvas renderer could leave one-frame stale glyphs on the wrong row during rapid redraw/scroll (e.g. spinner updates while output streams) — fixed (coalesced full refresh after writes/fits on iOS canvas path)
- [x] Mobile paste sheet lost unsent text on close and could grow too tall when history was long — fixed (save non-trivial drafts into paste history on close + cap history list with internal scroll)
- [x] Mobile paste modal required leaving the sheet to send Enter after `Send` — fixed (compact `↩` button next to `Send` emits CR in-place)
- [x] Mobile sidebar list was hard to scroll (incl. multi-host grouped sections clipping) — fixed (touch rows no longer expose draggable on coarse pointers + sidebar scroll containers hardened with `min-height: 0`/touch scrolling + host groups no longer flex-shrink)
- [x] Mobile toolbar overflowed horizontally on narrow phones — fixed (7-button primary row + collapsible macro tray for modifiers/hotkeys/select)
- [x] Session switch / auto-focus could inject literal `^[[I` into shell prompt when focus reporting was enabled (`?1004h`) — fixed (suppress immediate programmatic focus CSI reports in terminal manager)
- [x] Attach replay/session-switch viewport could land at top and sometimes miss the `Latest` overlay after fit/resize races — fixed (defer attach auto-scroll until replay flush/layout settles + recompute scroll-overlay state after terminal fits/resizes)
- [x] Delayed attach replay staging could wedge reattaches on narrow screens — fixed (remove the delayed staging path; resize first, then replay immediately and let redraw bytes stream live after attach)
- [x] Dev hot reload could strand pre-existing sessions after server-side `Session` shape changes — fixed (normalize `globalThis` sessions on reload before attach/list/detach touches newly added session fields)
- [x] Windows hosts defaulted to `cmd.exe`, had no live CWD parity, and depended on ambient Node installs — fixed (prefer Git Bash / OpenSSH default shell, parse hidden Git Bash cwd OSC frames, and bundle Node in the Windows installer)
- [x] Windows `LocalSystem` service sessions started in `systemprofile` instead of the intended user home — fixed (installer seeds `TING_WINDOWS_SESSION_HOME`, runtime falls back to the last login profile, and `install.ps1` now supports optional `ServiceUser` + password for true per-user services)

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
- [x] E2E test suite (Playwright) — 32 tests covering all key flows
- [x] Long-press context menu on mobile (pointerdown + 500ms, click suppression)
- [x] Drag-to-end (sentinel drop zone after last session item)
- [x] URL hash routing — `#<hostId>/<name>` deeplinks to session by host + name (legacy `#<name>` supported for local host)
- [x] Auto-attach to first session when no hash in URL
- [x] Kill-to-next — killing current session auto-navigates to nearest surviving session
- [x] primeTerminal — xterm.js instance created before container div exists so startup output buffers
- [x] Mobile toolbar — fixed-width primary row (macro/ESC/TAB/arrows/paste/Enter/keyboard) plus macro tray for sticky CTRL/SHIFT, 3 programmable hotkeys, and `select`
- [x] Mobile paste modal — `Send` action row includes compact `↩` button to send Enter without leaving the sheet
- [x] Mobile text selection mode — toolbar opens a native textarea scrollback snapshot for touch-friendly select/copy
- [x] Shared scroll-to-latest overlay button (desktop + mobile) — appears when scrolled up and jumps back to live output
- [x] Mobile toolbar polish — hotkey editor key-type switching fixed, ALT hotkey sequences, mutually exclusive toolbar overlays
- [x] iOS tap-to-keyboard disabled on terminal canvas; keyboard via toolbar button only
- [x] iOS Safari scroll-on-text bug fixed (Canvas renderer forced on iOS + renderer guard test)
- [x] Shared-session resize reclaim — active session click/foreground reapplies local PTY dimensions
- [x] Manual multi-host production verification (two real servers) — create/attach/input/kill/offline-reconnect validated end-to-end
- [x] Manual Windows production verification (`mom`) — Git Bash default shell, correct initial home/cwd, live CWD tracking, duplicate/create-with-CWD, rename, kill, and bundled-Node PTY worker path validated end-to-end

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
- [x] Auto-update — server polls GitHub releases, downloads new tarball, extracts in-place, exits for systemd restart
- [x] Deployment tooling — systemd unit, install script (`curl | sh`), release script (`bun run release`)
- [ ] Session persistence across restarts — detach PTYs into own process group (`setsid`) so they survive server restart/update
- [ ] Auto-update: only restart when idle (zero active sessions) to avoid killing running work
- [ ] Windows phase 5 — run Playwright / multi-host CI on Windows
- [ ] Custom launch command per session — start directly into `claude`, `ssh host`, etc.
- [ ] Search in scrollback — `xterm-addon-search`
- [ ] Font size adjustment in UI
- [ ] Session pinning
- [ ] Export scrollback as text
- [ ] Tmux session auto-discovery (dev-sessions MCP interop)

## Decisions made

- **Platform PTY split** — Unix/macOS use `Bun.spawn({ terminal: { ... } })`; Windows uses `node-pty` via a Node sidecar because Bun-on-Windows could spawn ConPTY on `mom` but failed on `write()`
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
- **GitHub releases + systemd for deployment** — no Docker, no registry. ~190KB tarball, 11MB memory at idle
- **Auto-update via GitHub releases API** — server polls, downloads, extracts, exits for systemd restart
- **CSWSH hostname-only matching** — peer origins matched by hostname (any port) since dev/prod use different ports
- **localhost always trusted** — servers only accessible over Tailscale anyway, no public exposure
