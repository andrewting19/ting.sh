# PTY Sidecar And Snapshot Reconnect Plan

## Current State

The original foundation work is complete:

- PTYs are sidecar-owned by local `ptyd`
- Bun server restarts no longer kill sessions
- Bun ↔ `ptyd` has an explicit protocol/version boundary
- Snapshot reconnect is the normal path for both renderers
- xterm restores from `xterm-vt-snapshot-v1`
- Ghostty restores:
  - normal-buffer sessions from `rendered-text-snapshot-v1`
  - alternate-screen sessions from `xterm-vt-snapshot-v1`
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

The remaining work is no longer architectural foundation work. It is validation and parity work:

1. more real redraw-heavy agent-trace validation
2. deeper Ghostty parity/fidelity work
3. deep readable history implementation, if we decide to ship it
4. merging the accumulated branch work back to `main`

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

### 2. Ghostty Parity Refinement

Goal:
- improve fidelity where Ghostty still diverges from xterm semantics

Primary open area:
- preserved normal-buffer scrollback semantics around alternate-screen and complex redraw flows

Success criteria:
- real-session evidence shows remaining gaps clearly
- fixes target actual user-visible divergence, not hypothetical parity

### 3. Deep Readable History Decision

Goal:
- decide whether to ship a separate readable-history mechanism now

Reference:
- [history-semantics.md](./history-semantics.md)

Decision options:

- defer deep history and keep current reconnect-focused model
- add a separate text-oriented readable-history store

Success criteria:
- product behavior is intentional
- reconnect correctness stays independent from deep-history retention

### 4. Final Cutover / Cleanup

Goal:
- retire stale raw-replay assumptions and merge the branch work

Success criteria:
- raw attach remains only where explicitly intended as compatibility/debug fallback
- docs reflect the current architecture
- branch is merged back to `main`

## Remaining Checklist

- [ ] Capture and study more real redraw-heavy agent sessions
- [ ] Record more real normal-buffer baselines from live Claude/Codex-style sessions
- [ ] Record more real alternate-screen baselines from live sessions
- [ ] Validate reconnect behavior on iPad/Tailscale against the updated snapshot path
- [x] Validate multi-client/shared-session behavior under the current snapshot path
- [ ] Identify the highest-value remaining Ghostty parity issue from real traces
- [ ] Implement the next Ghostty parity fix if a concrete issue is found
- [ ] Decide whether deep readable history is needed now
- [ ] If needed, design the readable-history store separately from reconnect state
- [ ] Merge the branch work back to `main`

## Non-Negotiable Constraints

- Session continuity matters more than developer convenience.
- The sidecar must remain the PTY owner.
- Snapshot state, not raw replay, is the reconnect source of truth.
- Real-session evidence should drive remaining renderer work.
