import { useEffect, useRef, useCallback, useMemo } from 'react'
import type { SessionKey } from '../types'
import { createTerminalBackend, type TerminalRenderer } from '../terminal/backends'
import type { DebuggableTerminalBackendInstance, TerminalBackendInstance, TerminalScrollState } from '../terminal/backends/types'
import type { TerminalSnapshot } from '../snapshot/types'

interface PendingWrite {
  data: Uint8Array
  onFlushed?: () => void
}

interface TerminalEntry {
  terminal: TerminalBackendInstance | null
  container: HTMLElement | null
  pendingWrites: PendingWrite[]
  pendingFocus: boolean
  pendingReset: boolean
  shouldBeActive: boolean
  // Programmatic term.focus() can emit CSI I/O when an app enabled focus
  // reporting (?1004h). Suppress only the immediate focus/blur report so the
  // shell prompt doesn't get literal "^[[I" inserted during session switches.
  suppressFocusReportUntil: number
  term?: unknown
}

interface Callbacks {
  onData: (sessionKey: SessionKey, data: string) => void
  onResize: (sessionKey: SessionKey, cols: number, rows: number) => void
  onScrollStateChange: (sessionKey: SessionKey, showScrollToBottom: boolean) => void
}

interface Options {
  backendId?: TerminalRenderer
}

const PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS = 150
const SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_LINES = 4

export function useTerminalManager(callbacks: Callbacks, options?: Options) {
  const entriesRef = useRef<Map<SessionKey, TerminalEntry>>(new Map())
  const activeIdRef = useRef<SessionKey | null>(null)
  const runtimeReadyRef = useRef(false)
  const backendRef = useRef(createTerminalBackend(options?.backendId))
  const attachDebugInfo = useCallback((entry: TerminalEntry, terminal: TerminalBackendInstance | null) => {
    const debugInfo = terminal && 'getDebugInfo' in terminal
      ? (terminal as DebuggableTerminalBackendInstance).getDebugInfo()
      : {}
    entry.terminal = terminal
    entry.term = debugInfo.term
  }, [])
  const createEntry = useCallback((): TerminalEntry => {
    return {
      terminal: null,
      container: null,
      pendingWrites: [],
      pendingFocus: false,
      pendingReset: false,
      shouldBeActive: false,
      suppressFocusReportUntil: 0,
    }
  }, [])
  // Always-fresh callbacks via ref — no stale closure issues
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks

  const ensureEntry = useCallback((sessionKey: SessionKey) => {
    let entry = entriesRef.current.get(sessionKey)
    if (!entry) {
      entry = createEntry()
      entriesRef.current.set(sessionKey, entry)
      cbRef.current.onScrollStateChange(sessionKey, false)
    }
    return entry
  }, [createEntry])

  const emitScrollState = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.terminal) return
    const scrollState = entry.terminal.getScrollState()
    cbRef.current.onScrollStateChange(sessionKey, scrollState.offsetFromBottom >= SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_LINES)
  }, [])
  const forwardTerminalData = useCallback((sessionKey: SessionKey, data: string) => {
    if (data === '\x1b[I' || data === '\x1b[O') {
      const entry = entriesRef.current.get(sessionKey)
      if (entry && performance.now() <= entry.suppressFocusReportUntil) return
    }
    if (activeIdRef.current === sessionKey) cbRef.current.onData(sessionKey, data)
  }, [])

  const flushPendingWrites = useCallback((sessionKey: SessionKey, entry: TerminalEntry) => {
    if (!entry.terminal || !entry.terminal.isOpened() || entry.pendingWrites.length === 0) return
    const writes = entry.pendingWrites.splice(0, entry.pendingWrites.length)
    for (const pending of writes) {
      entry.terminal.write(pending.data, () => {
        emitScrollState(sessionKey)
        pending.onFlushed?.()
      })
    }
  }, [emitScrollState])

  const ensureTerminalInstance = useCallback((sessionKey: SessionKey, entry: TerminalEntry) => {
    if (!runtimeReadyRef.current || entry.terminal) return
    const terminal = backendRef.current.createTerminal(sessionKey, {
      onData: forwardTerminalData,
      onScroll: emitScrollState,
      onResize: (key, cols, rows) => {
        cbRef.current.onResize(key, cols, rows)
      },
    })
    attachDebugInfo(entry, terminal)
    if (entry.container) {
      terminal.open(entry.container)
      if (entry.pendingReset) {
        terminal.reset()
        entry.pendingReset = false
      }
      terminal.setActive(entry.shouldBeActive)
      flushPendingWrites(sessionKey, entry)
      if (entry.pendingFocus) {
        entry.pendingFocus = false
        entry.suppressFocusReportUntil = performance.now() + PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS
        terminal.focus()
      }
      emitScrollState(sessionKey)
    }
  }, [attachDebugInfo, emitScrollState, flushPendingWrites, forwardTerminalData])

  useEffect(() => {
    let cancelled = false
    backendRef.current.init()
      .then(() => {
        if (cancelled) return
        runtimeReadyRef.current = true
        for (const [sessionKey, entry] of entriesRef.current.entries()) {
          ensureTerminalInstance(sessionKey, entry)
        }
      })
      .catch((err) => {
        console.error(`Failed to initialize ${backendRef.current.id} terminal backend`, err)
      })
    return () => {
      cancelled = true
    }
  }, [ensureTerminalInstance])

  // Create a Terminal instance without opening it (no container yet).
  // Terminal backends may buffer writes before open() or we may have to queue
  // them here until an async runtime finishes initializing.
  // open() is called, so binary that arrives before React re-renders (and
  // the container div appears) is captured rather than dropped.
  // Called from the 'ready' handler in App.tsx for 'create' flows.
  const primeTerminal = useCallback((sessionKey: SessionKey) => {
    const entry = ensureEntry(sessionKey)
    ensureTerminalInstance(sessionKey, entry)
    emitScrollState(sessionKey)
  }, [emitScrollState, ensureEntry, ensureTerminalInstance])

  const ensureTerminal = useCallback((sessionKey: SessionKey, container: HTMLElement) => {
    const entry = ensureEntry(sessionKey)
    entry.container = container
    ensureTerminalInstance(sessionKey, entry)
    if (entry.terminal) {
      if (!entry.terminal.isOpened()) {
        entry.terminal.open(container)
        if (entry.pendingReset) {
          entry.terminal.reset()
          entry.pendingReset = false
        }
        entry.terminal.setActive(entry.shouldBeActive)
        flushPendingWrites(sessionKey, entry)
        if (entry.pendingFocus) {
          entry.pendingFocus = false
          entry.suppressFocusReportUntil = performance.now() + PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS
          entry.terminal.focus()
        }
        emitScrollState(sessionKey)
      } else {
        entry.terminal.fit()
        emitScrollState(sessionKey)
      }
    }
  }, [emitScrollState, ensureEntry, ensureTerminalInstance, flushPendingWrites])

  // Switch the WebGL renderer to the newly active terminal.
  // Inactive terminals don't need GPU acceleration — they're invisible.
  const setActive = useCallback((sessionKey: SessionKey) => {
    const prevId = activeIdRef.current
    activeIdRef.current = sessionKey

    if (prevId && prevId !== sessionKey) {
      const prev = entriesRef.current.get(prevId)
      if (prev) prev.shouldBeActive = false
      prev?.terminal.setActive(false)
    }

    const entry = ensureEntry(sessionKey)
    entry.shouldBeActive = true
    ensureTerminalInstance(sessionKey, entry)
    if (entry?.terminal.isOpened()) {
      entry.terminal.setActive(true)
      entry.terminal.fit()
      emitScrollState(sessionKey)
    }
  }, [emitScrollState, ensureEntry, ensureTerminalInstance])

  const write = useCallback((sessionKey: SessionKey, data: Uint8Array, onFlushed?: () => void) => {
    const entry = ensureEntry(sessionKey)
    ensureTerminalInstance(sessionKey, entry)
    if (!entry.terminal || !entry.terminal.isOpened()) {
      entry.pendingWrites.push({ data: new Uint8Array(data), onFlushed })
      return
    }
    entry.terminal.write(data, () => {
      emitScrollState(sessionKey)
      onFlushed?.()
    })
  }, [emitScrollState, ensureEntry, ensureTerminalInstance])

  const restoreSnapshot = useCallback((sessionKey: SessionKey, snapshot: TerminalSnapshot, onFlushed?: () => void) => {
    const entry = ensureEntry(sessionKey)
    entry.pendingWrites = []
    ensureTerminalInstance(sessionKey, entry)
    if (!entry.terminal || !entry.terminal.isOpened() || !entry.terminal.restoreSnapshot) {
      return false
    }
    entry.pendingReset = false
    const restored = entry.terminal.restoreSnapshot(snapshot, () => {
      emitScrollState(sessionKey)
      onFlushed?.()
    })
    return restored
  }, [emitScrollState, ensureEntry, ensureTerminalInstance])

  const reset = useCallback((sessionKey: SessionKey) => {
    const entry = ensureEntry(sessionKey)
    entry.pendingWrites = []
    ensureTerminalInstance(sessionKey, entry)
    if (!entry.terminal || !entry.terminal.isOpened()) {
      entry.pendingReset = true
      cbRef.current.onScrollStateChange(sessionKey, false)
      return
    }
    entry.terminal.reset()
    emitScrollState(sessionKey)
  }, [emitScrollState, ensureEntry, ensureTerminalInstance])

  const scrollToBottom = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.terminal) return
    entry.terminal.scrollToBottom()
    emitScrollState(sessionKey)
  }, [emitScrollState])

  const scrollToTop = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.terminal) return
    entry.terminal.scrollToTop()
    emitScrollState(sessionKey)
  }, [emitScrollState])

  const focus = useCallback((sessionKey: SessionKey) => {
    const entry = ensureEntry(sessionKey)
    entry.pendingFocus = true
    entry.suppressFocusReportUntil = performance.now() + PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS
    ensureTerminalInstance(sessionKey, entry)
    if (entry.terminal && entry.terminal.isOpened()) {
      entry.pendingFocus = false
      entry.terminal.focus()
    }
  }, [ensureEntry, ensureTerminalInstance])

  const getDimensions = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.terminal?.getDimensions() ?? { cols: 80, rows: 24 }
  }, [])

  const getMeasuredDimensions = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    return entry?.terminal?.getMeasuredDimensions() ?? null
  }, [])

  const getScrollState = useCallback((sessionKey: SessionKey): TerminalScrollState | null => {
    const entry = entriesRef.current.get(sessionKey)
    return entry?.terminal?.getScrollState() ?? null
  }, [])

  const isOpened = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.terminal?.isOpened() ?? false
  }, [])

  const getApplicationCursorKeysMode = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.terminal?.getApplicationCursorKeysMode() ?? false
  }, [])

  const getBracketedPasteMode = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.terminal?.getBracketedPasteMode() ?? false
  }, [])

  const getBufferText = useCallback((sessionKey: SessionKey, scope?: 'visible' | 'all') => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.terminal) return ''
    return entry.terminal.getBufferText(scope)
  }, [])

  const getDebugTerm = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.term ?? null
  }, [])

  const destroy = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    cbRef.current.onScrollStateChange(sessionKey, false)
    entry.terminal?.dispose()
    entriesRef.current.delete(sessionKey)
    if (activeIdRef.current === sessionKey) activeIdRef.current = null
  }, [])

  // useMemo so the returned object has a stable reference across renders.
  // All functions are useCallback([]) so their refs never change, which means
  // this memo never re-computes. Without this, effects in App.tsx that list
  // `tm` as a dep would re-fire on every render and send spurious WS messages.
  return useMemo(
    () => ({ primeTerminal, ensureTerminal, setActive, write, restoreSnapshot, reset, scrollToTop, scrollToBottom, focus, getDimensions, getMeasuredDimensions, getScrollState, isOpened, getApplicationCursorKeysMode, getBracketedPasteMode, getBufferText, getDebugTerm, destroy }),
    [primeTerminal, ensureTerminal, setActive, write, restoreSnapshot, reset, scrollToTop, scrollToBottom, focus, getDimensions, getMeasuredDimensions, getScrollState, isOpened, getApplicationCursorKeysMode, getBracketedPasteMode, getBufferText, getDebugTerm, destroy]
  )
}
