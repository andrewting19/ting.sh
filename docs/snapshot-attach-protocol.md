# Snapshot Attach Protocol Notes

## Goal

Replace raw-replay attach with:

1. a consistent snapshot cut
2. a bounded live tail after that cut
3. a race-safe client handoff into the live stream

This note started as a high-level protocol sketch. The xterm path described here is now wired through `ptyd` and the real frontend attach flow; Ghostty-specific restore remains future work.

## Core Requirements

- No dropped bytes during attach.
- No duplicated bytes during attach.
- Attach latency should depend on snapshot size, not full PTY history.
- Snapshot semantics must be explicit per backend.
- The sidecar remains the source of truth for session state.

## Session State Needed In The Sidecar

Per session:

- `outputSeq`: monotonic output sequence number
- `snapshotTracker`: continuously updated terminal-state tracker
- `liveTail`: bounded queue of post-snapshot PTY chunks for attach handoff

The important point is that every PTY output chunk has an ordering token.

## Snapshot Cut

Current xterm implementation:

1. Sidecar waits for its ordered snapshot-write chain to settle.
2. Sidecar captures a snapshot from the state tracker.
3. Sidecar uses the matching `snapshotSeq` as `cutSeq`.
4. Any later PTY chunks already have `seq > cutSeq` in `liveTail`.

The snapshot is therefore defined as:

- terminal state as of `cutSeq`

Everything after that point belongs to the live tail.

## Protocol Shape

Suggested server -> client flow:

1. `snapshot-ready`
   - `sessionId`
   - `backend`
   - `cutSeq`
   - `snapshot`
2. `snapshot-tail`
   - ordered PTY chunks with `seq > cutSeq`
3. transition to normal live stream

Current client -> server acknowledgement:

1. client receives `snapshot-ready`
2. client restores snapshot locally
3. client sends `snapshot-applied`
4. server flushes buffered tail, then switches client to live streaming

This explicit ack is slower than fire-and-forget, but much easier to reason about initially.

## Why An Ack Helps

Without an ack, the server may start sending tail bytes before the client has finished restoring the snapshot, which creates ordering ambiguity inside the renderer.

With an ack:

- restore order is deterministic
- tail flush starts only after restore is complete
- debugging is much easier

The current xterm rollout intentionally biases toward correctness over minimal latency.

## Backend-Specific Snapshot Payloads

Current feasibility results suggest this should not assume a single renderer-neutral payload.

Likely payload shapes:

- `xterm-vt-snapshot-v1`
  - self-contained VT payload from headless xterm serialize
- `ghostty-snapshot-v1`
  - likely needs a Ghostty-specific restore representation or adapter

The envelope can still be shared:

```ts
type SnapshotEnvelope = {
  sessionId: string;
  backend: "xterm-vt-snapshot-v1" | "ghostty-snapshot-v1";
  cutSeq: number;
  capturedAt: number;
  cols: number;
  rows: number;
  payload: unknown;
};
```

## Remaining Open Questions

- Should `outputSeq` increment per PTY chunk or per byte range?
- How large should the buffered live tail be before fallback/error?
- Should reconnect clients receive the same tail chunks as already-attached clients or a client-specific queue?
- Can Ghostty restore from a richer canonical state model more faithfully than from xterm VT snapshots?
- How should deep readable history diverge from reconnect-state history once raw replay is retired?

## Recommended First Production Rollout

1. Keep the current xterm snapshot attach path as the production reconnect path for xterm.
2. Preserve raw attach as the Ghostty fallback until its restore adapter exists.
3. Add side-by-side metrics comparing replay attach vs snapshot attach on real redraw-heavy TUI traces.
4. Implement the Ghostty restore path only after its adapter semantics are defined.
