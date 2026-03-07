# ting.sh

A self-hosted web terminal so I can use my development machine from anywhere — phone, tablet, or another computer — as long as I'm on my Tailscale network.

The goal is to feel like I'm sitting at my machine: smooth terminal, full interactivity, sessions that stay alive when I close the tab. No compromises that make it feel like a remote workaround.

## Scope

- **Multi-machine** — not just the laptop. All machines on the Tailscale network (VPS servers etc.) should be reachable. Each machine runs its own server; a dashboard lists them all. Direct browser → machine connection over Tailscale, no hub/proxy hop.
- **Session persistence** — closing the browser tab doesn't kill the terminal. Reconnect and pick up where you left off.
- **Auto-updating** — servers poll for new versions and self-update, so deployment is set-and-forget.
- **General purpose** — not agent-specific. Just a terminal. Running Claude Code or Codex CLI in it is a use case, not the premise.

## Why not agentboard

Agentboard is close but has two fundamental constraints this project doesn't want:

1. **Tmux-coupled** — sessions are tmux windows. The terminal is proxied through tmux's `pipe-pane` / `send-keys` API rather than owning the PTY directly. This is why scrollback is glitchy and rendering artifacts appear.
2. **Agent-focused UI** — one window per coding agent. That's a subset of what a general terminal needs.

This project owns the PTY directly: Unix/macOS hosts use `Bun.spawn` with the native PTY API, while Windows hosts use ConPTY via `node-pty`. xterm.js builds its scrollback buffer from the raw byte stream, nothing in between. Scrolling is smooth because xterm.js holds all the data itself.

Tmux session detection is supported as an optional future feature (for interop with dev-sessions MCP etc.) but is not the core model.

## Stack

- **Runtime**: Bun
- **Backend**: Bun HTTP + WebSocket server; native `Bun.spawn` PTY on Unix/macOS, `node-pty` ConPTY worker on Windows
- **Frontend**: React + TypeScript, bundled by Vite
- **Terminal**: xterm.js 5.x with WebGL (desktop) + Canvas (iOS) + FitAddon

Dev: `bun run dev` — Vite on :4321 with HMR, WS server on :7681, proxied transparently
Prod: `bun run build && bun run start` — single Bun server on :7681 serves everything

## Deployment

Install on any Linux VPS (installs Bun, downloads latest release, sets up systemd):

```bash
curl -fsSL https://raw.githubusercontent.com/andrewting19/ting.sh/main/deploy/install.sh | sudo bash
```

Release a new version: `bun run release` (or `release:minor` / `release:major`). All VPS auto-update within 5 minutes.

Install on Windows (run in elevated PowerShell):

```powershell
irm https://raw.githubusercontent.com/andrewting19/ting.sh/main/deploy/install.ps1 | iex
```

Optional Windows service-account install:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/andrewting19/ting.sh/main/deploy/install.ps1))) -ServiceUser "DESKTOP-42S5MOA\\Andrew" -ServicePassword "<password>"
```

If `ServiceUser` is omitted, the installer keeps the NSSM service on `LocalSystem` but records the intended shell home so sessions start in your user profile instead of `C:\Windows\System32\config\systemprofile`. If you need the shell to run with your actual Windows user token (`whoami`, file/network permissions), you must install the service with `ServiceUser` + `ServicePassword`.

**Note:** auto-update restarts the server, which kills all running PTY sessions. Session persistence across restarts is on the roadmap.

### Multi-host setup

Each machine needs a `hosts.json` that identifies itself and lists its peers. All URLs must use **full Tailscale MagicDNS hostnames** (e.g. `machine-name.tail1234.ts.net`), not short hostnames — browsers send the full hostname as the Origin header, and the CSWSH check matches against it.

Find your MagicDNS suffix with `tailscale dns status` (look for "suffix = ...").

Example `/opt/ting.sh/hosts.json` for a machine called `dev-server`:

```json
{
  "id": "dev-server",
  "name": "Dev Server",
  "peers": [
    { "id": "macbook", "name": "MacBook", "url": "http://macbook.tail1234.ts.net:7681" },
    { "id": "vps", "name": "Cloud VPS", "url": "http://vps.tail1234.ts.net:7681" }
  ]
}
```

Every machine in the fleet needs its own `hosts.json` with the other machines as peers. After creating/editing: `systemctl restart ting-sh`.

**Environment variables** (set in `/opt/ting.sh/.env` or systemd unit):
- `PORT` — server port (default: 7681)
- `SHELL` — shell to spawn (default: system shell)
- `HOSTS_FILE` — path to hosts.json, or `none` to disable (default: `./hosts.json`)
- `AUTO_UPDATE` — set to `false` to disable (default: enabled)
- `AUTO_UPDATE_INTERVAL` — poll interval in ms (default: 300000 / 5min)
- `AUTO_UPDATE_REPO` — GitHub repo to poll (default: `andrewting19/ting.sh`)
- `TING_WINDOWS_SESSION_HOME` — Windows-only override for the shell home directory when the service itself runs as `LocalSystem`

## Current state

Working:
- Create / attach / kill sessions with custom confirm modal
- PTY sessions persist when browser tab closes — reconnect and resume
- Scrollback replay on reconnect (10MB buffer per session)
- WebSocket auto-reconnect with status indicator
- WebGL renderer on active terminal only (desktop); Canvas renderer forced on iOS
- Multiple browser tabs can share the same session simultaneously
- Per-session xterm.js instances — independent terminal state, no leaking between sessions
- Session rename — double-click or right-click/long-press context menu, persisted server-side
- Context menu — Rename, Duplicate, Kill (right-click on desktop; long-press on touch)
- Duplicate session — spawns in same CWD, inserts directly after source in sidebar
- Drag-and-drop session reordering in sidebar, persisted to per-host localStorage keys
- Host-scoped drag reorder hardening — drag source host is validated from live state during drag events (avoids stale-closure no-op drops)
- Champion names for auto-generated sessions (all 172 LoL champions)
- Live CWD subtitle in sidebar — updates on Enter keypress, 30s fallback poll. No shell config needed.
- Windows host support (validated on `mom`) — Git Bash is preferred over `cmd.exe` when available, CWD tracking works via a hidden Git Bash prompt hook, duplicate/create-with-CWD works on Windows hosts, and passwordless `LocalSystem` installs now default new shells to the intended user home instead of `systemprofile`
- Windows installer/runtime hardening — `deploy/install.ps1` now bundles a portable Node runtime for the PTY worker, supports configurable `ServiceName` / `Port` / optional `ServiceUser`, and Windows auto-update reinstalls dependencies after extracting a new release
- Dev server accessible over Tailscale / LAN (Vite bound to `0.0.0.0`, `allowedHosts: true`)
- Dev fail-fast wiring: `bun run dev` now tears down both processes if either Vite or the WS server exits, so backend crashes cannot leave a misleading "connected UI, reconnecting WS" state
- Keyboard shortcuts: `Alt+T` new session, `Alt+W` kill current, `Alt+1-9` switch on the active host
- Mobile support: hamburger sidebar, touch-friendly session switching, iOS scroll momentum
- Mobile sidebar scrolling hardening — touch scrolling now works reliably in single-host and multi-host grouped sidebars (touch rows no longer expose drag-reorder, scroll containers get explicit touch sizing, host sections no longer flex-shrink and clip rows)
- iOS Safari touch-start-on-text scroll bug fixed via canvas renderer path on iOS
- Mobile toolbar (iOS): non-scrolling primary row (macro, ESC, TAB, arrows, paste, Enter, ⌨) plus expandable macro tray for sticky CTRL/SHIFT, ALT-aware programmable hotkey slots (long-press to edit), and `select`, with coordinated overlay toggles
- Mobile text selection mode (toolbar macro tray `select`) — opens a scrollback snapshot in a native textarea sheet for reliable touch selection/copy and drag-to-scroll selection expansion
- Shared scroll-to-latest overlay button (desktop + mobile) — bottom-centered pill appears when the active terminal is scrolled up and jumps back to live output
- Mobile D-pad arrows now respect xterm application-cursor mode (`ESC O A/B/C/D`) for TUIs that require it (falls back to normal `ESC [ A/B/C/D`)
- Mobile keyboard avoidance (VisualViewport): terminal area, toolbar, arrow pad, and paste sheet now lift above the on-screen keyboard while typing
- iOS mobile focus zoom suppression hardened — toolbar modal inputs (paste + hotkey editor) now use mobile-specific selectors that win over later component styles, and xterm's hidden helper textarea is also forced to 16px so the ⌨ button doesn't zoom the page
- Mobile paste sheet now focuses the textarea immediately on open (instead of delayed focus) so the keyboard opens with the sheet more reliably on iOS
- Mobile paste sheet now saves longer unsent drafts into paste history on close, long history lists scroll inside a capped panel so the textarea/send controls stay visible above the keyboard, and a compact `↩` button can send Enter without leaving the sheet
- iOS canvas renderer repaint hardening — coalesced full-screen refreshes after rapid write/fit cycles reduce transient stale glyphs during noisy output (e.g. spinner redraws while scrollback is advancing)
- URL hash routing — `#<hostId>/<name>` deeplinks directly to a session (legacy `#<name>` still supported for local); auto-attaches on load
- Kill-to-next — killing current session auto-navigates to nearest surviving session
- Shared-session resize reclaim — re-selecting the active session (or returning foreground) reapplies local cols/rows after another client resized the PTY
- Mobile attach replay settle — attaching to an existing desktop-started session now briefly stages the socket after resize so SIGWINCH-driven redraws land before replay is snapshotted, which reduces mangled wraps/bleeding lines when opening TUIs like Codex CLI on a phone
- Attach de-race hardening — request-ID validated attach flow; stale attach responses are ignored so replay/output cannot leak into the wrong terminal during rapid switches
- Attach replay viewport restore hardening — after attach/reconnect replay flush, xterm now re-jumps to latest output after fit/resize settles and refreshes scroll-overlay state during terminal fits/resizes
- Programmatic focus-report suppression — app-driven `term.focus()` no longer injects literal `^[[I`/`^[[O` into shells when apps enabled xterm focus reporting (`?1004`)
- Reconnect stale-socket hardening — old WebSocket events are ignored once a newer socket takes over, preventing doubled output after reconnect/hot-reload races
- Truncated replay sanitization — when scrollback cap trims bytes, first partial line is dropped on reattach to avoid malformed escape-sequence rendering artifacts
- WebSocket CSWSH hardening — `/ws` validates browser `Origin`; allows same-origin + configured peer origins, rejects other cross-origin upgrades (non-browser clients without `Origin` still allowed)
- Automated E2E test suite (Playwright) — 32 tests, runs with `bun test`
- Multi-host protocol groundwork in server: `detach`, live `list` subscriptions, and `requestId`-correlated `ready` responses
- Multi-host server identity groundwork: optional `hosts.json`, `GET /api/host`, WS `host-info`, and `hostId` in session lists
- Frontend host-aware core types added: `Host`, `SessionKey`, and key helpers (`makeKey`/`parseKey`)
- Host connection engine scaffolded: `useHostConnections` + imperative `WSConnection` with per-host reconnect/send lifecycle
- App/terminal manager now run on host-scoped session keys and use multi-host WS transport plumbing (`useHostConnections`)
- Sidebar now supports host-grouped sections with per-host connection status and host-scoped drag/drop interactions
- Local host identity reconciliation — local host ID/name now follows server `host-info`/`/api/host` values instead of staying hardcoded as `local`
- Peer WS URL derivation now follows each peer base URL scheme (`http→ws`, `https→wss`) instead of the current page protocol
- Manual two-host production verification passed (create/attach/input/kill/reconnect across `server-a` + `server-b`)
- Legacy single-host `useWS` hook removed; host transport now flows only through `useHostConnections` / `WSConnection`
- Server control-message parsing now uses typed guards (no `any` in `server.ts` request handling paths)
- Auto-update — server polls GitHub releases, downloads new tarball, extracts in-place, exits for systemd restart
- `GET /api/version` — returns current running version
- Release tooling — `bun run release` bumps version, builds, tags, and publishes a GitHub release
- systemd unit template and `curl | sh` install script for VPS deployment

Missing / in progress:
- Multi-machine dashboard (auto-discovery from Tailscale)
- Windows CI / Playwright coverage (phase 5)

## Known limitations

**Sessions don't survive hard restarts.** PTY processes are OS child processes of the server — when the server process dies (crash, kill, machine reboot), the kernel sends SIGHUP to all children and they die. The `globalThis` trick only preserves sessions across Bun `--hot` module reloads (same process, module re-evaluated). True cross-restart persistence would require detaching PTYs into their own process group (like tmux does with `setsid`), which is a significant architectural change.

**Some full-screen TUIs can intentionally wipe xterm scrollback during redraw (observed with Claude Code).** This can look like a random "flicker/scroll jump" bug where the viewport suddenly snaps and the `latest` button cannot stay at the bottom. In the observed case, the PTY stream included `CSI 2J` (clear screen), `CSI 3J` (clear scrollback), and `CSI H` (cursor home) in the **normal buffer** (not an attach/reconnect path, and not a client-side replay/reset bug). xterm.js is behaving correctly by collapsing scrollback and resetting the viewport after `CSI 3J`.

This appears inconsistent because the TUI does not emit the same redraw sequence every frame. Some frames are incremental (no `CSI 3J`), while others trigger a full redraw path that clears scrollback.

If this becomes a recurring UX issue, the safest mitigation is an **opt-in compatibility mode** that ignores only `CSI 3J` (clear scrollback) on the client, ideally via xterm parser hooks (`parser.registerCsiHandler` for `CSI J` with param `3`). Do not blindly auto-scroll after every redraw; that fights the app and causes jank. Trade-off: ignoring `CSI 3J` means apps (or `clear`/`reset`) can no longer intentionally clear scrollback in that mode.

## Future ideas

### Multiplayer

Sessions already broadcast to multiple clients — the groundwork is there. A full multiplayer model would add roles:

- `owner` — full control of the PTY
- `collaborator` — can type directly (pair programming)
- `viewer` — read-only, sees live output
- `suggester` — read-only view + can submit commands for the owner to approve

The suggestion flow: guest types a command in a separate panel (not directly into the terminal), it appears as a pending item, owner clicks to send it to the PTY or dismiss it. Clean separation — the terminal stays the owner's, suggestions are clearly distinct.

Access via invite links with the role baked in: `/join/<token>`.

The privacy consideration: even read-only exposes everything in the terminal (env vars, file contents, etc.), so sharing should be explicit and intentional.

### Other ideas

- Custom command per session — launch directly into `claude`, `ssh host`, etc. instead of plain shell
- Search in scrollback (`xterm-addon-search`)
- Tmux session auto-discovery by prefix (dev-sessions MCP interop)
- Session pinning / grouping
- Export scrollback as text
- Broadcast input across multiple sessions simultaneously
