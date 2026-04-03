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

**Note:** Bun server restarts no longer kill PTY sessions because a local `ptyd` sidecar owns them. Full process / machine restarts still kill sessions today; true boot-persistent sessions remain future work.

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

### Renderer selection

The app now supports two browser terminal backends behind the same manager contract:

- `xterm` — current default
- `ghostty` — opt-in alternate renderer

Select a renderer locally with:

```js
localStorage.setItem('wt-terminal-renderer', 'ghostty')
location.reload()
```

Switch back with:

```js
localStorage.setItem('wt-terminal-renderer', 'xterm')
location.reload()
```

Renderer choice is read once at startup and switched by a full-page reload on purpose. That avoids trying to migrate live terminal state between renderers.

There is also a minimal header toggle in the UI: `>_` for xterm.js and `👻` for Ghostty.

## Current state

Working:
- Create / attach / kill sessions with custom confirm modal
- PTY sessions persist when browser tab closes — reconnect and resume
- PTY sidecar foundation — Bun now proxies session traffic to a local-only `ptyd` process, so PTYs survive real Bun server restarts instead of depending on in-process hot-reload state
- Raw replay buffer retained (10MB cap per session) for legacy/fallback attach paths and diagnostics
- xterm snapshot attach is now wired end-to-end for xterm renderer sessions — reconnect restores a compact headless-xterm VT snapshot plus ordered live tail instead of replaying the full raw buffer
- Ghostty snapshot attach is now also wired end-to-end — reconnect now requests snapshot attach for Ghostty too, using rendered-text snapshots for normal-buffer sessions and xterm VT snapshots for alternate-screen sessions
- Ghostty now uses snapshot attach for both normal-buffer and alternate-screen sessions: rendered-text snapshots for normal buffer, xterm VT snapshots for alternate screen
- Shared-session snapshot handoff is now covered in protocol tests for both renderers — an already attached writer stays live while a second client snapshot-attaches, acknowledges the snapshot, and then both clients continue receiving subsequent PTY output
- WebSocket auto-reconnect with status indicator
- WebGL renderer on active terminal only (desktop); Canvas renderer forced on iOS
- Multiple browser tabs can share the same session simultaneously
- Per-session xterm.js instances — independent terminal state, no leaking between sessions
- Terminal backend boundary scaffolded — `useTerminalManager` now orchestrates a shared backend interface and ships both xterm and Ghostty implementations on this branch
- Dev/test terminal inspection no longer depends on raw xterm instances — E2E now uses a backend-neutral `__wt_terminal_debug` helper
- Terminal manager now supports async backend initialization, and Ghostty has been added as a second backend implementation behind the shared contract
- Startup renderer selection is supported via `localStorage['wt-terminal-renderer']` and a minimal header toggle, both using a full-page reload remount path (`xterm` default, `ghostty` opt-in)
- Ghostty runtime bumped to `@andrewting19/ghostty-web@0.5.6` on this branch — line-height is honored, OSC 52 clipboard writes propagate to the browser clipboard, macOS Option is treated as Meta, freed terminals no longer leak stale cells, long scrollback stays stable, mouse-tracked TUIs receive wheel coordinates correctly, FitAddon no longer reserves a fake scrollbar gutter that left a right-edge gap, `OSC 10/11/12` color queries are answered in JS instead of spamming WASM warnings, and mobile focus now targets Ghostty's hidden textarea instead of exposing a full-screen visible input surface on iOS
- Mobile session selection no longer auto-focuses the terminal on narrow layouts — switching sessions does not summon/zoom the iOS keyboard, while the toolbar keyboard button remains the explicit focus path
- Ghostty mobile touch scrolling now matches xterm direction on iOS-style swipe gestures
- Mobile keyboard dismissal now reclaims terminal height cleanly — the keyboard inset still animates the toolbar every frame, but the active terminal waits briefly for the iOS keyboard motion to settle before refitting, which avoids stale gaps and resize thrash
- Core Playwright parity coverage now runs under both renderers for create/input/switch/reload/reconnect/focus-report flows
- Browser-use smoke coverage has also been exercised under both renderers for create/input/switch/reload flows against the live dev server
- Session rename — double-click or right-click/long-press context menu, persisted server-side
- Context menu — Rename, Duplicate, Kill (right-click on desktop; long-press on touch)
- Duplicate session — spawns in same CWD, inserts directly after source in sidebar
- Drag-and-drop session reordering in sidebar, persisted to per-host localStorage keys
- Host-scoped drag reorder hardening — drag source host is validated from live state during drag events (avoids stale-closure no-op drops)
- Champion names for auto-generated sessions (all 172 LoL champions)
- Live CWD subtitle in sidebar — updates on Enter keypress with short retries for browser-driven `cd`s, plus a 30s fallback poll. No shell config needed.
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
- Attach de-race hardening — request-ID validated attach flow; stale attach responses are ignored so replay/output cannot leak into the wrong terminal during rapid switches
- Measured attach handshake — hash-load/reconnect attaches now wait for a real fitted xterm size before sending `attach`, so shared PTYs are never briefly resized to fallback `80x24` before replay
- Dev attach replay diagnostics — `ready` now reports replay bytes/line breaks/trim status, and the dev build exposes `window.__wt_attach_metrics.measureSession()` / `.measureAll()` so live sessions can be profiled by attach latency versus replay size without restarting the server
- Snapshot attach ordering hardening — `ptyd` now tracks monotonic output sequence numbers plus a bounded live tail, and xterm reconnect waits for `snapshot-ready` -> local restore -> `snapshot-applied` -> ordered tail flush before live binary resumes
- Local live-trace capture tooling — `ptyd` now exposes a localhost-only debug session dump and `bun run scripts/capture-session-trace.ts <session-id>` can persist a running session’s raw replay buffer plus serialized snapshot for offline analysis
- Batch live-trace capture — `bun run scripts/capture-session-trace.ts --all [output-dir]` captures every live session in one pass, which matches the new batch reconnect measurement workflow for real agent-trace validation
- Resize-aware live trace capture — captured session JSON now also includes bounded ordered trace events, preserving raw chunk boundaries and explicit PTY resizes for better real-session fidelity analysis
- Richer capture analysis summaries — `bun run scripts/analyze-session-capture.ts <capture-json>` now reports initial/final terminal size plus trace event counts and resize counts, so resize-heavy real sessions are easier to compare without hand-inspecting JSON
- History semantics are now explicit in docs — reconnect state, immediate terminal scrollback, and optional deeper readable history are defined separately in [docs/history-semantics.md](./docs/history-semantics.md) so future work does not overload raw PTY replay
- Deep readable history is intentionally deferred for now — reconnect correctness and immediate in-terminal scrollback now come from snapshot state, while a separate long-range history store stays out of scope until real usage proves it is needed
- Snapshot attach protocol docs are current again — [docs/snapshot-attach-protocol.md](./docs/snapshot-attach-protocol.md) now reflects the real production split: xterm VT snapshots plus Ghostty rendered-text-or-xterm-VT restore, rather than the older raw-fallback plan
- The main sidecar/snapshot plan doc is now current again — [docs/pty-sidecar-snapshot-plan.md](./docs/pty-sidecar-snapshot-plan.md) has been rewritten around remaining work rather than the already-completed early phases
- Ghostty alternate-screen snapshot path — Ghostty no longer falls back to raw attach when the active buffer is alternate-screen; it now restores the visible alternate-screen state from an xterm VT snapshot while deeper parity work remains open
- The main remaining Ghostty parity gap is now explicit: normal-buffer restores preserve visible content and semantic scrollback, but not xterm's exact baseY / viewport-offset behavior across rendered-text restore and mixed normal/alternate-screen flows
- Trace capture now prefers the active Bun server as a debug proxy (`/api/debug/session`, `/api/sidecar`) before falling back to direct sidecar access, so tooling follows whichever `ptyd` instance that server is actually using
- Capture analysis tooling — `bun run scripts/analyze-session-capture.ts <capture-json>` summarizes raw replay vs xterm snapshot vs rendered-text snapshot size ratios from a saved live-session capture
- Reconnect measurement tooling — `bun run scripts/measure-session-reconnect.ts <session-id> [renderer]` compares raw attach versus snapshot attach against the active server and reports replay bytes, snapshot bytes, tail bytes, and end-to-end timings
- Batch reconnect measurement — `bun run scripts/measure-session-reconnect.ts --all [renderer]` measures every live session on the active server in one pass, which is better suited to real agent-trace validation runs
- One-shot live study workflow — `bun run scripts/study-live-sessions.ts [renderer|both] [output-dir]` now captures, measures, and summarizes every live session into a single report JSON, with `both` producing side-by-side xterm and Ghostty reconnect data
- Reconnect measurement is now safer for active shared sessions — the script first asks the active server for the session’s current cols/rows and reattaches at those dimensions instead of forcing `80x24`
- Synthetic trace benchmarking — `bun run scripts/benchmark-pty-trace.ts redraw` or `alternate` generates a PTY trace and reports raw-vs-snapshot size ratios without needing a live session
- Synthetic benchmark baseline (April 2, 2026) — the built-in `redraw` trace produced `3464` raw bytes versus a `152`-byte xterm snapshot and `164`-byte rendered-text snapshot (`~22x` smaller), while the built-in `alternate` trace produced `590` raw bytes versus a `574`-byte xterm snapshot and `627`-byte rendered-text snapshot (roughly parity). This reinforces the current direction: snapshot reconnect buys a lot on redraw-heavy normal-buffer churn, but alternate-screen sessions still need renderer-specific handling rather than assuming the snapshot will always be much smaller.
- Synthetic resize benchmark baseline (April 2, 2026) — the built-in `resize` trace now models explicit PTY resizes alongside redraws and produced `471` raw bytes versus an `88`-byte xterm snapshot and `100`-byte rendered-text snapshot (`~5.35x` / `~4.71x` smaller). Snapshot state tracking still compresses resize-heavy normal-buffer sessions well when resize events are applied explicitly instead of inferred from bytes.
- Live dev-server redraw baseline (April 2, 2026) — a fresh redraw-heavy `tracebench` session on the current dev server measured `8908` raw replay bytes versus a `56`-byte xterm snapshot and `107`-byte Ghostty rendered-text snapshot. Local reconnect timing on that session was about `254ms` via raw attach, `11.6ms` via xterm snapshot attach, and `1.7ms` via Ghostty snapshot attach.
- Live direct-PTY alternate-screen baseline (April 2, 2026) — a fresh non-tmux `altbench` session running `less` on the dev server measured `3214` raw replay bytes versus a `1372`-byte xterm snapshot and `1524`-byte Ghostty rendered-text snapshot. On that small direct alternate-screen session, raw attach was actually slightly faster locally than snapshot attach, so alternate-screen needs to be evaluated by real app shape and fidelity, not assumed to compress dramatically.
- Live agent-TUI baselines (April 2, 2026) — current `Jax` and `Viego` Codex/Claude-style sessions both stayed in the normal buffer but still showed only moderate payload shrinkage compared with toy redraw traces:
  - `Jax`: `112033` raw bytes, `62012` xterm snapshot bytes, `61113` Ghostty rendered-text bytes (`~1.8x` smaller than raw)
  - `Viego`: `302449` raw bytes, `130277` xterm snapshot bytes, `93959` Ghostty rendered-text bytes (`~2.3x` / `~3.2x` smaller than raw)
  - browser-side xterm attach metrics on localhost for the currently running sessions were still fast: first write flush at about `23.3ms` for `Jax` and `26.3ms` for `Viego`
  This means real coding-agent TUIs are not universally “tiny snapshot” cases; snapshot reconnect still helps, but the benefit depends on how much redraw churn versus durable visible content the app leaves in the normal buffer.
- Live alternate-screen agent baseline (April 2, 2026) — `Tahm Kench` on the current dev server was a real alternate-screen session with `1,407,167` raw bytes in capture, `14,780` xterm snapshot bytes, `8,779` rendered-text bytes, and only `3` resize events across `4,526` trace events. Reconnect measurements on localhost showed:
  - xterm: raw `~12.0ms` vs snapshot `~5.5ms`
  - Ghostty: raw `~4.6ms` vs snapshot `~24.9ms`
  This reinforces that alternate-screen behavior is now functionally on the snapshot path for both renderers, but Ghostty performance/parity still needs real-trace-driven refinement instead of assumptions from payload size alone.
- One-shot live study baseline (April 2, 2026) — running `bun run scripts/study-live-sessions.ts ghostty captures/study-manual` against the same live `Tahm Kench` session later captured a larger alternate-screen state (`3,835,642` raw bytes, `15,995` xterm snapshot bytes, `9,110` rendered-text bytes, `7` resize events). In that run Ghostty snapshot reconnect measured `~2.4ms` versus raw `~6.8ms`, which shows the Ghostty alternate-screen path is not uniformly slower; its behavior depends on the live session shape, timing, and current output state.
- Side-by-side live study baseline (April 2, 2026) — running `bun run scripts/study-live-sessions.ts both captures/study-both-manual` against the live `Tahm Kench` session later still showed extreme alternate-screen shrinkage (`5,869,837` raw bytes, `15,718` xterm snapshot bytes, `6,996` rendered-text bytes). In that run snapshot reconnect beat raw for both renderers:
  - xterm: raw `~11.6ms`, snapshot `~2.1ms`
  - Ghostty: raw `~10.8ms`, snapshot `~2.3ms`
  That makes the current open Ghostty work more about parity/fidelity across real states than about basic snapshot-attach viability or raw-vs-snapshot speed.
- Live mixed-session study baseline (April 3, 2026) — running `bun run scripts/study-live-sessions.ts both captures/study-both-2026-04-03` against the current dev server measured both a large alternate-screen session and a small normal-buffer session:
  - `Tahm Kench` (alternate): `10,485,760` raw bytes with trimming at the legacy cap, `5,676` xterm snapshot bytes, `4,417` rendered-text bytes; reconnect timings were xterm raw `~15.9ms` vs snapshot `~2.3ms`, Ghostty raw `~12.8ms` vs snapshot `~1.7ms`
  - `Vayne` (normal): `18,600` raw bytes, `2,313` xterm snapshot bytes, `2,406` rendered-text bytes; reconnect timings were xterm raw `~0.75ms` vs snapshot `~1.03ms`, Ghostty raw `~0.71ms` vs snapshot `~1.10ms`
  This is the clearest current evidence that snapshot attach is the right default for correctness and heavy sessions, but very small normal-buffer sessions are already cheap enough that raw can still win on localhost latency.
- Snapshot UTF-8 decoding fixed in code — the snapshot tracker now decodes PTY byte chunks with streaming UTF-8 instead of `latin1`, which preserves box-drawing glyphs and fixes the `â` / `Â` / `Ã` mojibake seen in agent-TUI snapshots. Existing live sessions will still show the old behavior until `ptyd` is restarted.
- Live UTF-8 snapshot verification (April 2, 2026) — after restarting `ptyd`, a fresh `utf8check` session confirmed that both xterm VT snapshots and Ghostty rendered-text snapshots preserve real box-drawing glyphs (`╭│╰`) with no mojibake.
- Stale sidecar detection — `ptyd` health now reports whether the running sidecar fingerprint differs from the files on disk, `/api/sidecar` exposes that state, and the dev header shows a `stale ptyd` badge when the running sidecar is older than the checked-out code.
- Versioned sidecar protocol boundary — `/api/sidecar` now reports the expected protocol version, the running sidecar's protocol version, and whether they are compatible so Bun↔`ptyd` drift is explicit instead of implicit.
- Sidecar respawn coverage — Bun now has integration coverage proving it can recreate a dead `ptyd` on demand and continue serving fresh sessions without a Bun restart.
- Attach replay viewport restore hardening — after attach/reconnect replay flush, xterm now re-jumps to latest output after fit/resize settles and refreshes scroll-overlay state during terminal fits/resizes
- Programmatic focus-report suppression — app-driven `term.focus()` no longer injects literal `^[[I`/`^[[O` into shells when apps enabled xterm focus reporting (`?1004`)
- Terminal resize storm hardening — terminal-originated resize sends are now trailing-debounced and deduped so animated browser/sidebar resizes do not spam shared PTYs with dozens of intermediate sizes
- Manual terminal layout refresh button — header `↻` button sends a one-column PTY width nudge out/back for the active session, which can help recover some bad resize redraw states in shared TUIs
- Reconnect stale-socket hardening — old WebSocket events are ignored once a newer socket takes over, preventing doubled output after reconnect/hot-reload races
- Truncated replay sanitization — when scrollback cap trims bytes, first partial line is dropped on reattach to avoid malformed escape-sequence rendering artifacts
- WebSocket CSWSH hardening — `/ws` validates browser `Origin`; allows same-origin + configured peer origins, rejects other cross-origin upgrades (non-browser clients without `Origin` still allowed)
- Automated E2E test suite (Playwright) — 53 tests, including a shared xterm/Ghostty renderer matrix for core parity flows plus a Bun integration test that proves PTYs survive Bun server restart
- Multi-host protocol groundwork in server: `detach`, live `list` subscriptions, and `requestId`-correlated `ready` responses
- Multi-host server identity groundwork: optional `hosts.json`, `GET /api/host`, WS `host-info`, and `hostId` in session lists
- Frontend host-aware core types added: `Host`, `SessionKey`, and key helpers (`makeKey`/`parseKey`)
- Host connection engine scaffolded: `useHostConnections` + imperative `WSConnection` with per-host reconnect/send lifecycle
- App/terminal manager now run on host-scoped session keys and use multi-host WS transport plumbing (`useHostConnections`)
- Terminal backend scaffold extracted: xterm-specific lifecycle, WebGL activation, and iOS touch scrolling now live behind a backend module boundary
- Sidebar now supports host-grouped sections with per-host connection status and host-scoped drag/drop interactions
- Multi-host sidebar scroll hitbox hardening — per-host session lists no longer create nested wheel/touch scroll regions, so scrolling works consistently even when the pointer is over a host's session rows
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

**Sessions still do not survive full process or machine restarts.** PTYs now survive Bun web-server restarts because `ptyd` owns them, but `ptyd` itself is still a normal process. If the sidecar or machine dies, the PTYs die too. True boot-persistent sessions would require a stronger detached runtime model.

**Some full-screen TUIs can intentionally wipe xterm scrollback during redraw (observed with Claude Code).** This can look like a random "flicker/scroll jump" bug where the viewport suddenly snaps and the `latest` button cannot stay at the bottom. In the observed case, the PTY stream included `CSI 2J` (clear screen), `CSI 3J` (clear scrollback), and `CSI H` (cursor home) in the **normal buffer** (not an attach/reconnect path, and not a client-side replay/reset bug). xterm.js is behaving correctly by collapsing scrollback and resetting the viewport after `CSI 3J`.

This appears inconsistent because the TUI does not emit the same redraw sequence every frame. Some frames are incremental (no `CSI 3J`), while others trigger a full redraw path that clears scrollback.

If this becomes a recurring UX issue, the safest mitigation is an **opt-in compatibility mode** that ignores only `CSI 3J` (clear scrollback) on the client, ideally via xterm parser hooks (`parser.registerCsiHandler` for `CSI J` with param `3`). Do not blindly auto-scroll after every redraw; that fights the app and causes jank. Trade-off: ignoring `CSI 3J` means apps (or `clear`/`reset`) can no longer intentionally clear scrollback in that mode.

**Some redraw-heavy TUIs can also emit a broken resize redraw in the normal buffer (reproduced in ting.sh, xterm.js, ghostty-web, and native Ghostty).** The observed pattern after a PTY `resize` is: `CSI ? 2026 h` (synchronized output), then a very large run of blank `\\r\\r\\n` lines in the normal buffer, then only the bottom prompt/footer is redrawn before `CSI ? 2026 l`. This leaves the viewport sitting at the bottom of a blank block, which looks like “the whole upper terminal went black after resize.”

This is not currently believed to be a ting.sh renderer bug. Debouncing browser-driven resize storms helps reduce how often a TUI gets kicked into that path, but once the app emits the broken redraw, browsers and native terminals alike appear to render it faithfully.

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
