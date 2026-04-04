# PTY Sidecar And Snapshot Reconnect Plan

## Current State

The original foundation work is complete:

- PTYs are sidecar-owned by local `ptyd`
- Bun server restarts no longer kill sessions
- Bun ↔ `ptyd` has an explicit protocol/version boundary
- Snapshot reconnect is the normal path for both renderers
- xterm restores from `xterm-vt-snapshot-v1`
- Ghostty restores from `xterm-vt-snapshot-v1` for both normal-buffer and alternate-screen reconnects, with viewport restoration layered on top for normal-buffer sessions
- Ordered live-tail handoff is implemented with `snapshot-ready` / `snapshot-applied` / `snapshot-tail` / `snapshot-complete`
- Shared-session snapshot handoff is covered for both renderers, including a writer that stays attached while a second client joins via snapshot attach and both continue receiving subsequent PTY output
- Rich live-session study tooling now exists:
  - batch capture
  - batch reconnect measurement
  - one-shot study reports

Supporting docs:

- [snapshot-attach-protocol.md](./snapshot-attach-protocol.md)
- [history-semantics.md](./history-semantics.md)

## What Has Been Proven

- xterm snapshot reconnect is viable end-to-end.
- Ghostty snapshot reconnect is viable end-to-end.
- Real alternate-screen sessions can compress dramatically under snapshot capture.
- Snapshot reconnect can beat raw reconnect for both xterm and Ghostty on real alternate-screen sessions.
- Resize-heavy sessions can be captured and benchmarked with explicit resize events.

## What Is Still Unfinished

The remaining work is no longer architectural foundation work. It is validation work:

1. more real redraw-heavy agent-trace validation
2. final real-device / remote-network validation
3. targeted fixes for any remaining TUI-specific redraw bugs that real sessions still expose

## Remaining Plan

### 1. Real Session Validation

Goal:
- use the new live-study tooling on more real Claude/Codex-style sessions

Success criteria:
- multiple real sessions are captured and measured
- we have representative normal-buffer and alternate-screen baselines
- reconnect behavior is understood on the actual workloads that matter

Current tools:

- `bun run scripts/capture-session-trace.ts --all <output-dir>`
- `bun run scripts/measure-session-reconnect.ts --all xterm`
- `bun run scripts/measure-session-reconnect.ts --all ghostty`
- `bun run scripts/study-live-sessions.ts both <output-dir>`

### 2. Final Validation / Cleanup

Goal:
- retire stale raw-replay assumptions in docs and validate the finished reconnect path against the real environments that motivated this work

Success criteria:
- raw attach remains only where explicitly intended as compatibility/debug fallback
- docs reflect the current architecture
- the current reconnect path is validated on real devices and remote links
- any remaining real-session redraw bugs are treated as concrete follow-up bugs, not as a reason to reopen the snapshot architecture itself

## Remaining Checklist

- [ ] Capture and study more real redraw-heavy agent sessions
- [ ] Record more real normal-buffer baselines from live Claude/Codex-style sessions
- [ ] Record more real alternate-screen baselines from live sessions
- [ ] Validate reconnect behavior on iPad/Tailscale against the updated snapshot path
- [ ] Reproduce and fix the remaining real Claude/agent-TUI redraw corruption cases that still show up in fresh live sessions
- [x] Validate multi-client/shared-session behavior under the current snapshot path
- [x] Identify the highest-value remaining Ghostty parity issue from real traces
- [x] Implement the next Ghostty parity fix if a concrete issue is found
- [x] Decide whether deep readable history is needed now
- [x] Defer a separate readable-history store until real usage shows immediate snapshot scrollback is insufficient

## Non-Negotiable Constraints

- Session continuity matters more than developer convenience.
- The sidecar must remain the PTY owner.
- Snapshot state, not raw replay, is the reconnect source of truth.
- Real-session evidence should drive remaining renderer work.
