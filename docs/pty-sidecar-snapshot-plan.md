# PTY Sidecar And Snapshot Reconnect Plan

## Context

The current architecture keeps PTYs inside the Bun web server process and restores sessions by replaying a capped raw byte buffer on attach. That creates two structural problems:

- Server restarts kill live sessions because the PTYs are child processes of the Bun server.
- Reconnect correctness and performance depend on replaying raw PTY history, which is both slow for redraw-heavy TUIs and fragile when the retained tail depends on older discarded state.

The long-term direction is:

1. Move PTY ownership into a long-lived local sidecar process.
2. Make reconnect restore terminal state from snapshots instead of raw replay.

This document is the high-level execution plan for that work.

## Current Status

- Phase 1 sidecar foundation is complete locally: Bun now proxies browser traffic to a local-only `ptyd` process, and PTYs survive real Bun server restarts under integration test coverage.
- Initial snapshot feasibility work has identified a concrete xterm path: `@xterm/headless` plus `@xterm/addon-serialize`.
- A local roundtrip POC now passes for both redraw-heavy normal-buffer state and alternate-buffer state by serializing a headless xterm snapshot and restoring it into a fresh headless terminal.
- The POC now also consumes captured shell PTY traces and shows that serialized snapshots collapse redraw-heavy churn into a much smaller self-contained VT payload.
- Ghostty feasibility now has a concrete result from a browser-backed harness: Ghostty can consume the xterm-emitted VT snapshot and recover the visible alternate-screen content, but it does not preserve xterm's full normal-buffer/scrollback semantics or exact alternate-screen layout/cursor positioning from that same snapshot.
- A second Ghostty browser-backed POC now shows that a simpler rendered-text VT script also fails to preserve normal-buffer scrollback semantics, so the gap is not just a quirk of xterm's serialize output.
- A richer `canonical-terminal-snapshot-v1` shape is now codified from the headless xterm state model, capturing both buffers, scrollback offsets, cursor state, and wrapped-line metadata as the likely source model for any future Ghostty adapter.
- The latest Ghostty browser-backed POCs refine that result:
  - for normal-buffer sessions, a rendered-text VT script can reproduce the readable line content and semantic scrollback history well enough for reading
  - but it still does not preserve xterm-equivalent internal buffer offsets
  - and once the active state is alternate-screen, that same approach still loses the preserved normal scrollback
- Architectural implication: a single xterm-emitted VT snapshot is viable for the xterm reconnect path, but exact cross-renderer restore likely requires backend-specific adapters or a richer canonical state model than "VT payload only".
- `ptyd` now also maintains monotonic output sequence numbers and a bounded live-tail buffer alongside the shadow snapshot tracker, so the remaining snapshot-attach work can build on real ordering/tail primitives instead of adding them later.
- An initial xterm production rollout is now wired through the real app path: xterm reconnect requests `attach-snapshot`, restores the serialized VT snapshot locally, acknowledges with `snapshot-applied`, receives ordered `snapshot-tail` chunks, and only then transitions back to the live binary stream.
- `ptyd` now also exposes a localhost-only debug session dump, and `scripts/capture-session-trace.ts` can persist a running session's raw replay buffer plus serialized snapshot for real-world trace analysis without restarting the app.
- The biggest remaining unknowns are:
  - fidelity against real redraw-heavy traces from coding-agent TUIs
  - restore parity in Ghostty
  - long-term history semantics beyond the reconnect snapshot

## Non-Negotiable Constraints

- Session continuity matters more than developer convenience.
- The PTY/runtime boundary must survive Bun server restarts.
- The sidecar must be local-only and never exposed to the public network.
- The final reconnect model must be renderer-neutral and support both xterm and Ghostty unless feasibility work proves otherwise.
- Raw PTY replay must stop being the source of truth for reconnect correctness.
- We should prefer a clean architectural boundary over a narrowly scoped workaround.

## Phase Overview

### Phase 0: Land Current Branch

Goal:
- Merge the current feature branch into `main` and continue all follow-up work from a fresh branch off `main`.

Requirements / constraints:
- Merge the branch as-is after removing the Claude-specific compat mode.
- Keep the repo clean before merge.

Success criteria:
- `main` contains the current terminal-backend work and attach diagnostics.
- Follow-up work starts from a fresh branch based on `main`.

### Phase 1: Introduce A PTY Sidecar

Goal:
- Decouple PTYs from the Bun server so server restarts no longer kill sessions.

Requirements / constraints:
- Existing frontend behavior should remain largely unchanged.
- Sidecar must own PTY lifecycle and session identity.
- IPC should be local-only: Unix socket on Unix/macOS, named pipe or equivalent on Windows.

Success criteria:
- PTYs survive Bun server restart.
- Bun can reconnect to the sidecar and recover the active session list.
- Core flows still work: create, attach, input, resize, kill, reconnect.

### Phase 2: Stabilize The Sidecar Boundary

Goal:
- Turn the Bun server into a gateway/control server rather than the PTY owner.

Requirements / constraints:
- Session IDs and lifecycle semantics must be explicit across the boundary.
- Output ordering must remain deterministic.
- The boundary should be suitable for later snapshot/state ownership.

Success criteria:
- A defined internal API exists for session create/list/attach/detach/input/resize/kill.
- Server restarts are operationally safe because PTYs are independent.

### Phase 3: Run Snapshot Feasibility POCs

Goal:
- Validate the reconnect architecture before committing to a full build-out.

Requirements / constraints:
- Use real redraw-heavy traces, not only toy examples.
- Keep this phase exploratory and measurable.

Success criteria:
- We know whether a server-side terminal state engine and frontend snapshot restore are feasible enough to continue.

### Phase 4: Add Server-Authoritative Terminal State

Goal:
- Maintain the current rendered terminal state continuously on the backend side.

Requirements / constraints:
- PTY bytes remain the live input stream.
- Terminal state becomes the reconnect source of truth.
- Raw retained bytes stop being correctness-critical.

Success criteria:
- Each session has a maintained terminal-state model that can generate a reconnect snapshot.

### Phase 5: Replace Raw-Replay Attach With Snapshot Attach

Goal:
- Restore from snapshot plus a small live tail instead of replaying large raw histories.

Requirements / constraints:
- Snapshot cutover must be race-safe.
- Attach must remain deterministic during live output.
- Rollout should support side-by-side validation before full cutover.

Success criteria:
- Attach latency is bounded by snapshot size rather than raw PTY churn.
- Truncated raw replay is no longer a reconnect correctness issue.

### Phase 6: Formalize History Semantics

Goal:
- Define what "scrollback" means in the new architecture.

Requirements / constraints:
- Separate reconnect state from deeper readable history.
- Preserve useful scroll-up behavior for coding agent TUIs.

Success criteria:
- Product behavior is intentional and documented.
- Reconnect no longer depends on preserving arbitrary raw ANSI history.

### Phase 7: Hardening And Final Cutover

Goal:
- Make snapshot-based reconnect the default path and retire raw-replay attach.

Requirements / constraints:
- Validate against real iPad/Tailscale and redraw-heavy TUI usage.
- Keep strong automated coverage across both renderers.

Success criteria:
- Snapshot attach is the normal behavior.
- Server restarts are safe.
- Long-running TUI sessions reconnect quickly and cleanly.

## Required POCs

### POC 1: Headless Terminal State Engine

Question:
- Can we maintain accurate terminal state on the backend side from PTY bytes alone?

Must validate:
- normal buffer
- alternate buffer
- cursor state
- scrollback
- resize behavior
- redraw-heavy TUIs

Decision gate:
- If the state engine cannot model real sessions with acceptable fidelity, do not proceed with the snapshot architecture as planned.

### POC 2: Common Snapshot Schema

Question:
- Can one snapshot shape drive both xterm and Ghostty restore paths?

Must validate:
- lines/cells
- wrapped-line metadata
- active buffer
- cursor information
- dimensions
- payload size

Decision gate:
- If the schema becomes too renderer-specific, we need either a stronger abstraction or a narrowed renderer scope.

### POC 3: xterm Restore From Snapshot

Question:
- Can xterm restore from a structured snapshot without requiring historical ANSI replay?

Decision gate:
- If xterm restore cannot be made deterministic, reconnect architecture must be reconsidered.

### POC 4: Ghostty Restore From Snapshot

Question:
- Can Ghostty restore from the same structured snapshot with acceptable fidelity?

Decision gate:
- If Ghostty cannot restore from the common snapshot, we need to decide whether to add backend-specific adaptation or reduce scope.

### POC 5: Snapshot + Live Tail Handoff

Question:
- Can we cut a snapshot, resume live output, and avoid dropped/doubled bytes during attach?

Decision gate:
- If handoff is race-prone, the protocol design must be revised before implementation continues.

## Detailed Checklist

- [x] Merge the current feature branch into `main`.
- [x] Create a fresh follow-up branch from `main` for sidecar/snapshot work.
- [x] Define the sidecar's responsibility boundary versus the Bun server.
- [x] Choose local IPC transport per platform.
- [ ] Define a versioned internal protocol for Bun <-> sidecar communication.
- [x] Decide whether the sidecar is implemented in Bun, Node, or split by platform.
- [x] Define stable session identity semantics across sidecar and Bun restarts.
- [x] Move PTY creation into the sidecar.
- [x] Move PTY input/write handling into the sidecar.
- [x] Move PTY resize handling into the sidecar.
- [x] Move session kill/lifecycle handling into the sidecar.
- [x] Expose session listing and attach metadata from the sidecar.
- [ ] Make Bun reconnect to the sidecar on startup and after sidecar disconnects.
- [x] Add tests proving PTYs survive Bun server restart.
- [x] Add tests proving attached clients can reconnect after Bun restart.
- [x] Evaluate server-side headless terminal state engine options and select POC target.
- [ ] Capture real PTY traces from redraw-heavy sessions for snapshot feasibility testing.
- [x] Prototype a headless terminal state engine that consumes recorded PTY traces.
- [x] Evaluate fidelity for normal shell sessions.
- [ ] Evaluate fidelity for Claude Code / Codex-style redraw-heavy TUIs.
- [ ] Evaluate fidelity for resize-heavy sessions.
- [x] Draft a renderer-neutral `TerminalSnapshot` type.
- [ ] Measure snapshot payload size on representative real sessions.
- [x] Prototype xterm snapshot restore.
- [x] Prototype Ghostty snapshot restore.
- [x] Decide whether the restore path needs backend-specific adapters.
- [x] Design the snapshot attach protocol including sequence/handoff semantics.
- [x] Prototype snapshot cut + live tail handoff under concurrent output.
- [x] Add a feature flag for snapshot attach.
- [ ] Add side-by-side debug tooling to compare replay attach versus snapshot attach.
- [ ] Introduce a server-authoritative terminal-state store per session.
- [ ] Feed PTY bytes into the state store continuously.
- [ ] Ensure resize events update state-store dimensions correctly.
- [ ] Ensure alternate-buffer transitions are represented correctly.
- [ ] Implement snapshot generation from the state store.
- [x] Teach the frontend backend contract to restore from snapshot.
- [x] Implement xterm production restore path.
- [ ] Implement Ghostty production restore path.
- [x] Change attach flow to request/receive/restore snapshot before live tail.
- [x] Keep raw replay attach as a temporary fallback while snapshot reconnect rolls out per renderer.
- [x] Validate snapshot attach on local desktop workflows.
- [ ] Validate snapshot attach on iPad over Tailscale.
- [ ] Validate multi-client/shared-session behavior under snapshot attach.
- [ ] Define the long-term story for deep readable history versus reconnect state.
- [ ] Decide whether to retain a separate text-history store for export/search/deep reading.
- [ ] Remove raw-replay attach from the normal path once snapshot attach is proven.
- [ ] Update README and TODO to describe the new architecture and semantics.

## Phase-by-Phase Exit Criteria

### Exit Phase 1

- Bun restart no longer kills PTYs.
- The sidecar is the only PTY owner.
- Existing user workflows still function.

### Exit Phase 2

- The Bun <-> sidecar contract is stable enough to support new reconnect behavior.
- Restart behavior is exercised in tests.

### Exit Phase 3

- All required POCs have a documented result.
- We have explicit go/no-go answers on fidelity, payload size, and restore feasibility.

### Exit Phase 4

- Backend-side state can represent the current terminal well enough to generate reconnect snapshots reliably.

### Exit Phase 5

- Snapshot attach works end-to-end behind a flag.
- Attach no longer depends on replaying large raw histories for correctness.

### Exit Phase 6

- Scrollback/history semantics are intentional and documented.

### Exit Phase 7

- Snapshot attach is the default reconnect path.
- Raw replay is no longer a normal reconnect mechanism.
- Real-world redraw-heavy TUI reconnects are fast and visually stable.
