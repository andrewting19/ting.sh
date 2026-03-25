import { useRef, useCallback, useMemo } from 'react'
import type { SessionKey } from '../types'
import { createTerminalBackend } from '../terminal/backends'
import type { DebuggableTerminalBackendInstance, TerminalBackendInstance, TerminalScrollState } from '../terminal/backends/types'

interface TerminalEntry {
  terminal: TerminalBackendInstance
  // Programmatic term.focus() can emit CSI I/O when an app enabled focus
  // reporting (?1004h). Suppress only the immediate focus/blur report so the
  // shell prompt doesn't get literal "^[[I" inserted during session switches.
  suppressFocusReportUntil: number
  term?: unknown
  opened?: boolean
}

interface Callbacks {
  onData: (sessionKey: SessionKey, data: string) => void
  onResize: (sessionKey: SessionKey, cols: number, rows: number) => void
  onScrollStateChange: (sessionKey: SessionKey, showScrollToBottom: boolean) => void
}

const PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS = 150
const SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_LINES = 4

export function useTerminalManager(callbacks: Callbacks) {
  const entriesRef = useRef<Map<SessionKey, TerminalEntry>>(new Map())
  const backendRef = useRef(createTerminalBackend())
  const createEntry = useCallback((terminal: TerminalBackendInstance): TerminalEntry => {
    const entry: TerminalEntry = { terminal, suppressFocusReportUntil: 0 }
    const debugInfo = 'getDebugInfo' in terminal
      ? (terminal as DebuggableTerminalBackendInstance).getDebugInfo()
      : {}
    Object.defineProperties(entry, {
      opened: {
        enumerable: true,
        get: () => terminal.isOpened(),
      },
      term: {
        enumerable: true,
        get: () => debugInfo.term,
      },
    })
    return entry
  }, [])

  const activeIdRef = useRef<SessionKey | null>(null)
  // Always-fresh callbacks via ref — no stale closure issues
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks
  const emitScrollState = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
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

  // Create a Terminal instance without opening it (no container yet).
  // xterm.js processes write() calls into its internal VT buffer even before
  // open() is called, so binary that arrives before React re-renders (and
  // the container div appears) is captured rather than dropped.
  // Called from the 'ready' handler in App.tsx for 'create' flows.
  const primeTerminal = useCallback((sessionKey: SessionKey) => {
    if (entriesRef.current.has(sessionKey)) return
    const terminal = backendRef.current.createTerminal(sessionKey, {
      onData: forwardTerminalData,
      onScroll: emitScrollState,
      onResize: (key, cols, rows) => {
        cbRef.current.onResize(key, cols, rows)
      },
    })
    entriesRef.current.set(sessionKey, createEntry(terminal))
    emitScrollState(sessionKey)
  }, [createEntry, emitScrollState, forwardTerminalData])

  const ensureTerminal = useCallback((sessionKey: SessionKey, container: HTMLElement) => {
    const existing = entriesRef.current.get(sessionKey)

    if (existing) {
      if (!existing.terminal.isOpened()) {
        existing.terminal.open(container)
        emitScrollState(sessionKey)
      } else {
        existing.terminal.fit()
        emitScrollState(sessionKey)
      }
      return
    }

    const terminal = backendRef.current.createTerminal(sessionKey, {
      onData: forwardTerminalData,
      onScroll: emitScrollState,
      onResize: (key, cols, rows) => {
        cbRef.current.onResize(key, cols, rows)
      },
    })
    terminal.open(container)
    entriesRef.current.set(sessionKey, createEntry(terminal))
    emitScrollState(sessionKey)
  }, [createEntry, emitScrollState, forwardTerminalData])

  // Switch the WebGL renderer to the newly active terminal.
  // Inactive terminals don't need GPU acceleration — they're invisible.
  const setActive = useCallback((sessionKey: SessionKey) => {
    const prevId = activeIdRef.current

    if (prevId && prevId !== sessionKey) {
      const prev = entriesRef.current.get(prevId)
      prev?.terminal.setActive(false)
    }

    activeIdRef.current = sessionKey

    const entry = entriesRef.current.get(sessionKey)
    if (entry?.terminal.isOpened()) {
      entry.terminal.setActive(true)
      entry.terminal.fit()
      emitScrollState(sessionKey)
    }
  }, [emitScrollState])

  const write = useCallback((sessionKey: SessionKey, data: Uint8Array, onFlushed?: () => void) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.terminal.write(data, () => {
      emitScrollState(sessionKey)
      onFlushed?.()
    })
  }, [emitScrollState])

  const reset = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.terminal.reset()
    emitScrollState(sessionKey)
  }, [emitScrollState])

  const scrollToBottom = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.terminal.scrollToBottom()
    emitScrollState(sessionKey)
  }, [emitScrollState])

  const scrollToTop = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.terminal.scrollToTop()
    emitScrollState(sessionKey)
  }, [emitScrollState])

  const focus = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.suppressFocusReportUntil = performance.now() + PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS
    entry.terminal.focus()
  }, [])

  const getDimensions = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.terminal.getDimensions() ?? { cols: 80, rows: 24 }
  }, [])

  const getMeasuredDimensions = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    return entry?.terminal.getMeasuredDimensions() ?? null
  }, [])

  const getScrollState = useCallback((sessionKey: SessionKey): TerminalScrollState | null => {
    const entry = entriesRef.current.get(sessionKey)
    return entry?.terminal.getScrollState() ?? null
  }, [])

  const isOpened = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.terminal.isOpened() ?? false
  }, [])

  const getApplicationCursorKeysMode = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.terminal.getApplicationCursorKeysMode() ?? false
  }, [])

  const getBufferText = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return ''
    return entry.terminal.getBufferText()
  }, [])

  const destroy = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    cbRef.current.onScrollStateChange(sessionKey, false)
    entry.terminal.dispose()
    entriesRef.current.delete(sessionKey)
    if (activeIdRef.current === sessionKey) activeIdRef.current = null
  }, [])

  // useMemo so the returned object has a stable reference across renders.
  // All functions are useCallback([]) so their refs never change, which means
  // this memo never re-computes. Without this, effects in App.tsx that list
  // `tm` as a dep would re-fire on every render and send spurious WS messages.
  return useMemo(
    () => ({ primeTerminal, ensureTerminal, setActive, write, reset, scrollToTop, scrollToBottom, focus, getDimensions, getMeasuredDimensions, getScrollState, isOpened, getApplicationCursorKeysMode, getBufferText, destroy }),
    [primeTerminal, ensureTerminal, setActive, write, reset, scrollToTop, scrollToBottom, focus, getDimensions, getMeasuredDimensions, getScrollState, isOpened, getApplicationCursorKeysMode, getBufferText, destroy]
  )
}
