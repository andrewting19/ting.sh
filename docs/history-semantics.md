# History Semantics

## Goal

Define what "scrollback" means once reconnect no longer depends on replaying raw PTY history.

This separates three concerns that were previously conflated:

1. exact reconnect state
2. visible in-terminal scrollback immediately after reconnect
3. deeper readable history beyond the reconnect window

## Principles

- Reconnect correctness must come from snapshot state, not from replaying an arbitrary raw ANSI tail.
- The terminal should restore what the user was just looking at, including meaningful recent scrollback.
- Deep history is a product decision, not an accidental side effect of retaining raw PTY bytes.
- Raw PTY buffers are transport/debug artifacts, not the long-term user-facing history model.

## Definitions

### Reconnect State

The minimum state needed to make attach/reconnect feel like the session never disappeared.

This includes:

- active buffer (`normal` or `alternate`)
- visible terminal contents
- recent scrollback that the renderer can immediately scroll through
- cursor position and relevant terminal modes
- terminal dimensions
- small ordered post-snapshot live tail

Reconnect state is authoritative for correctness.

### Immediate Scrollback

The scrollable history that should be available inside the terminal immediately after reconnect.

This is part of the snapshot model, not a replay side effect.

For xterm, this can be preserved with serialized VT state.
For Ghostty, this may be approximate until a richer adapter exists.

### Deep Readable History

Older history beyond what is needed for reconnect.

This is primarily for:

- reading prior agent output
- search/export
- post-hoc inspection after a reconnect

This should not be required to restore terminal correctness.

## Product Model

The long-term product model should be:

1. reconnect restores snapshot state plus ordered live tail
2. the terminal exposes immediate scrollback from that snapshot
3. optional deeper history is stored separately in a readable form

This means:

- reconnect remains fast and deterministic
- redraw-heavy TUIs do not force megabytes of historical replay
- deep history can be tuned independently from reconnect performance

## What Counts As Success

After reconnect:

- the current screen matches the last meaningful rendered state
- scrolling up shows recent useful terminal history without obvious corruption
- the experience does not depend on a raw replay buffer being self-contained

For deeper history:

- users can still inspect older session output if the product chooses to retain it
- but that retention mechanism does not control reconnect correctness

## Recommended Storage Split

### Snapshot State

Stored per session and updated continuously.

Used for:

- reconnect
- fast renderer restore
- preserving immediate scrollback

### Ordered Live Tail

Small bounded raw queue after the latest snapshot cut.

Used for:

- race-safe attach handoff
- deterministic transition back to live streaming

### Optional Readable History Store

Separate from snapshot state.

Suggested shape:

- append-oriented text/history records
- renderer-agnostic
- searchable/exportable
- not required to preserve full ANSI fidelity

## What We Are Explicitly Not Promising

- infinite exact historical terminal fidelity across reconnects
- preservation of every historical redraw instruction
- identical internal scrollback semantics across xterm and Ghostty today

The correct product promise is:

- accurate reconnect of current state
- meaningful recent scrollback
- deeper history handled deliberately, not accidentally

## Near-Term Implications

- raw attach should remain only as a compatibility/debug fallback
- snapshot attach should be the normal reconnect path for both renderers
- future deep-history work should add a dedicated readable-history mechanism instead of expanding raw replay buffers

## Open Follow-Up Work

- decide whether deep readable history is required in-product now or can wait
- choose the storage model for deep history if needed
- improve Ghostty parity for preserved normal-buffer scrollback semantics
