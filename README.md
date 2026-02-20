# web-terminal

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

This project owns the PTY directly via `Bun.spawn` with the native PTY API. xterm.js builds its scrollback buffer from the raw byte stream, nothing in between. Scrolling is smooth because xterm.js holds all the data itself.

Tmux session detection is supported as an optional future feature (for interop with dev-sessions MCP etc.) but is not the core model.

## Stack

- **Runtime**: Bun
- **Backend**: Bun HTTP + WebSocket server, `Bun.spawn` native PTY API (no node-pty)
- **Frontend**: React + TypeScript, bundled by Vite
- **Terminal**: xterm.js 5.x with WebGL renderer + FitAddon

Dev: `bun run dev` — Vite on :4321 with HMR, WS server on :7681, proxied transparently
Prod: `bun run build && bun run start` — single Bun server on :7681 serves everything

## Current state

Working:
- Create / attach / kill sessions with custom confirm modal
- PTY sessions persist when browser tab closes — reconnect and resume
- Scrollback replay on reconnect (10MB buffer per session)
- WebSocket auto-reconnect with status indicator
- WebGL renderer on active terminal only (canvas fallback; WebGL skipped on mobile)
- Multiple browser tabs can share the same session simultaneously
- Per-session xterm.js instances — independent terminal state, no leaking between sessions
- Session rename — double-click or right-click/long-press context menu, persisted server-side
- Context menu — Rename, Duplicate, Kill (right-click on desktop; long-press on touch)
- Duplicate session — spawns in same CWD, inserts directly after source in sidebar
- Drag-and-drop session reordering in sidebar, persisted to localStorage
- Champion names for auto-generated sessions (all 172 LoL champions)
- Live CWD subtitle in sidebar — updates on Enter keypress, 30s fallback poll. No shell config needed.
- Dev server accessible over Tailscale / LAN (Vite bound to `0.0.0.0`, `allowedHosts: true`)
- Keyboard shortcuts: `Alt+T` new session, `Alt+W` kill current, `Alt+1-9` switch
- Mobile support: hamburger sidebar, touch-friendly session switching, iOS keyboard

Missing / in progress:
- Automated E2E test suite (Playwright) — top priority
- Multi-machine dashboard
- Auto-update mechanism
- URL-based direct session linking (`#<id>`)

## Known limitations

**Sessions don't survive hard restarts.** PTY processes are OS child processes of the server — when the server process dies (crash, kill, machine reboot), the kernel sends SIGHUP to all children and they die. The `globalThis` trick only preserves sessions across Bun `--hot` module reloads (same process, module re-evaluated). True cross-restart persistence would require detaching PTYs into their own process group (like tmux does with `setsid`), which is a significant architectural change.

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
