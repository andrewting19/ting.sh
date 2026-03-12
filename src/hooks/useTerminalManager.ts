import { useCallback, useEffect, useMemo, useRef } from 'react'
import { FitAddon, Terminal, init as initGhostty } from 'ghostty-web'
import type { SessionKey } from '../types'

interface PendingWrite {
  data: Uint8Array
  onFlushed?: () => void
}

interface TerminalAdapter {
  term: Terminal
  fitAddon: FitAddon
  open: (container: HTMLElement) => void
  fit: () => void
  write: (data: Uint8Array, onFlushed?: () => void) => void
  reset: () => void
  focus: () => void
  blur: () => void
  scrollToBottom: () => void
  dispose: () => void
  getDimensions: () => { cols: number; rows: number }
  getMeasuredDimensions: () => { cols: number; rows: number } | null
  getApplicationCursorKeysMode: () => boolean
  getBufferText: () => string
  getLinesFromBottom: () => number
}

interface TerminalEntry {
  adapter: TerminalAdapter | null
  term: Terminal | null
  ro: ResizeObserver | null
  opened: boolean
  container: HTMLElement | null
  pendingWrites: PendingWrite[]
  pendingFocus: boolean
  pendingReset: boolean
  shouldBeActive: boolean
  momentumCleanup: (() => void) | null
  suppressFocusReportUntil: number
}

interface Callbacks {
  onData: (sessionKey: SessionKey, data: string) => void
  onResize: (sessionKey: SessionKey, cols: number, rows: number) => void
  onScrollStateChange: (sessionKey: SessionKey, showScrollToBottom: boolean) => void
  onTerminalReady: (sessionKey: SessionKey, cols: number, rows: number) => void
}

const TERMINAL_OPTIONS = {
  fontSize: 13,
  lineHeight: 1.2,
  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
  cursorBlink: true,
  cursorStyle: 'block' as const,
  scrollback: 10000,
  smoothScrollDuration: 0,
  theme: {
    background: '#0d0e17',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#0d0e17',
    selectionBackground: '#283457',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
}

const PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS = 150
const SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_LINES = 4

let ghosttyInitPromise: Promise<void> | null = null

function ensureGhosttyReady(): Promise<void> {
  if (!ghosttyInitPromise) ghosttyInitPromise = initGhostty()
  return ghosttyInitPromise
}

void ensureGhosttyReady().catch(() => {
  // Surface the actual error from hook-level startup where we can log it once.
})

function isIOSDevice(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function createTerminalAdapter(
  sessionKey: SessionKey,
  onData: (sessionKey: SessionKey, data: string) => void,
  onScroll: (sessionKey: SessionKey) => void,
): TerminalAdapter {
  const term = new Terminal(TERMINAL_OPTIONS)
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  term.onData((data) => {
    onData(sessionKey, data)
  })
  term.onScroll(() => {
    onScroll(sessionKey)
  })

  return {
    term,
    fitAddon,
    open(container) {
      term.open(container)
      fitAddon.fit()
    },
    fit() {
      fitAddon.fit()
    },
    write(data, onFlushed) {
      term.write(data, onFlushed)
    },
    reset() {
      term.reset()
    },
    focus() {
      term.focus()
    },
    blur() {
      term.blur()
    },
    scrollToBottom() {
      term.scrollToBottom()
    },
    dispose() {
      term.dispose()
    },
    getDimensions() {
      return { cols: term.cols, rows: term.rows }
    },
    getMeasuredDimensions() {
      if (term.cols <= 0 || term.rows <= 0) return null
      return { cols: term.cols, rows: term.rows }
    },
    getApplicationCursorKeysMode() {
      return term.getMode(1, false)
    },
    getBufferText() {
      const buffer = term.buffer.active
      let out = ''
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i)
        if (!line) continue
        if (i > 0 && !line.isWrapped) out += '\n'
        out += line.translateToString(true)
      }
      return out
    },
    getLinesFromBottom() {
      return Math.max(0, Math.floor(term.getViewportY()))
    },
  }
}

function getTerminalLineHeight(container: HTMLElement, term: Terminal): number {
  const canvas = container.querySelector('canvas')
  if (canvas && term.rows > 0) {
    const rect = canvas.getBoundingClientRect()
    if (rect.height > 0) return rect.height / term.rows
  }
  return 20
}

function attachIOSScroll(container: HTMLElement, term: Terminal): (() => void) | null {
  if (!isIOSDevice()) return null

  const prevTouchAction = container.style.touchAction
  container.style.touchAction = 'none'

  const samples: { y: number; t: number }[] = []
  let lastY = 0
  let rafId: number | null = null

  const scrollByPixels = (deltaY: number) => {
    const lineHeight = getTerminalLineHeight(container, term)
    if (lineHeight <= 0) return
    const lineDelta = deltaY / lineHeight
    if (lineDelta !== 0) term.scrollLines(-lineDelta)
  }

  const cancelMomentum = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    cancelMomentum()
    samples.length = 0
    lastY = e.touches[0].pageY
    samples.push({ y: lastY, t: performance.now() })
    e.preventDefault()
  }

  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    e.preventDefault()
    const y = e.touches[0].pageY
    const deltaY = lastY - y
    lastY = y
    scrollByPixels(deltaY)
    samples.push({ y, t: performance.now() })
    if (samples.length > 8) samples.shift()
    e.stopPropagation()
  }

  const onTouchEnd = (e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (samples.length < 2) return
    const last = samples[samples.length - 1]
    const prev = samples[samples.length - 2]
    const dt = last.t - prev.t
    if (dt <= 0 || dt > 100) return

    let velocity = (prev.y - last.y) / dt
    if (Math.abs(velocity) < 0.1) return

    let prevFrame = performance.now()
    const animate = (now: number) => {
      const elapsed = Math.min(now - prevFrame, 32)
      prevFrame = now
      if (Math.abs(velocity) < 0.05) {
        rafId = null
        return
      }
      scrollByPixels(velocity * elapsed)
      velocity *= Math.pow(0.94, elapsed / 16.67)
      rafId = requestAnimationFrame(animate)
    }
    rafId = requestAnimationFrame(animate)
  }

  const onTouchCancel = () => {
    cancelMomentum()
    samples.length = 0
    lastY = 0
  }

  const captureActive = { capture: true, passive: false } as const
  const capturePassive = { capture: true, passive: true } as const
  container.addEventListener('touchstart', onTouchStart, captureActive)
  container.addEventListener('touchmove', onTouchMove, captureActive)
  container.addEventListener('touchend', onTouchEnd, captureActive)
  container.addEventListener('touchcancel', onTouchCancel, capturePassive)

  return () => {
    cancelMomentum()
    container.style.touchAction = prevTouchAction
    container.removeEventListener('touchstart', onTouchStart, captureActive)
    container.removeEventListener('touchmove', onTouchMove, captureActive)
    container.removeEventListener('touchend', onTouchEnd, captureActive)
    container.removeEventListener('touchcancel', onTouchCancel, capturePassive)
  }
}

function createEntry(): TerminalEntry {
  return {
    adapter: null,
    term: null,
    ro: null,
    opened: false,
    container: null,
    pendingWrites: [],
    pendingFocus: false,
    pendingReset: false,
    shouldBeActive: false,
    momentumCleanup: null,
    suppressFocusReportUntil: 0,
  }
}

export function useTerminalManager(callbacks: Callbacks) {
  const entriesRef = useRef<Map<SessionKey, TerminalEntry>>(new Map())
  const activeIdRef = useRef<SessionKey | null>(null)
  const runtimeReadyRef = useRef(false)
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks

  const emitScrollState = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.adapter) return
    const linesFromBottom = entry.adapter.getLinesFromBottom()
    cbRef.current.onScrollStateChange(sessionKey, linesFromBottom >= SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_LINES)
  }, [])

  const forwardTerminalData = useCallback((sessionKey: SessionKey, data: string) => {
    if (data === '\x1b[I' || data === '\x1b[O') {
      const entry = entriesRef.current.get(sessionKey)
      if (entry && performance.now() <= entry.suppressFocusReportUntil) return
    }
    if (activeIdRef.current === sessionKey) cbRef.current.onData(sessionKey, data)
  }, [])

  const ensureEntry = useCallback((sessionKey: SessionKey) => {
    let entry = entriesRef.current.get(sessionKey)
    if (!entry) {
      entry = createEntry()
      entriesRef.current.set(sessionKey, entry)
      cbRef.current.onScrollStateChange(sessionKey, false)
    }
    return entry
  }, [])

  const flushPendingWrites = useCallback((sessionKey: SessionKey, entry: TerminalEntry) => {
    if (!entry.adapter || !entry.opened || entry.pendingWrites.length === 0) return
    const writes = entry.pendingWrites.splice(0, entry.pendingWrites.length)
    for (const pending of writes) {
      entry.adapter.write(pending.data, () => {
        emitScrollState(sessionKey)
        pending.onFlushed?.()
      })
    }
  }, [emitScrollState])

  const notifyTerminalReady = useCallback((sessionKey: SessionKey, entry: TerminalEntry) => {
    const dims = entry.adapter?.getMeasuredDimensions()
    if (!dims) return
    cbRef.current.onTerminalReady(sessionKey, dims.cols, dims.rows)
  }, [])

  const openEntry = useCallback((sessionKey: SessionKey, entry: TerminalEntry, container: HTMLElement) => {
    if (!entry.adapter || entry.opened) return

    entry.container = container
    entry.adapter.open(container)
    entry.opened = true
    entry.momentumCleanup = attachIOSScroll(container, entry.adapter.term)

    const ro = new ResizeObserver(() => {
      if (!entry.adapter) return
      entry.adapter.fit()
      emitScrollState(sessionKey)
      const dims = entry.adapter.getMeasuredDimensions()
      if (!dims) return
      cbRef.current.onResize(sessionKey, dims.cols, dims.rows)
    })
    ro.observe(container)
    entry.ro = ro

    if (entry.pendingReset) {
      entry.adapter.reset()
      entry.pendingReset = false
    }
    flushPendingWrites(sessionKey, entry)
    if (!entry.shouldBeActive) entry.adapter.blur()
    if (entry.pendingFocus || entry.shouldBeActive) {
      entry.pendingFocus = false
      entry.suppressFocusReportUntil = performance.now() + PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS
      entry.adapter.focus()
    }

    emitScrollState(sessionKey)
    notifyTerminalReady(sessionKey, entry)
  }, [emitScrollState, flushPendingWrites, notifyTerminalReady])

  const ensureAdapter = useCallback((sessionKey: SessionKey, entry: TerminalEntry) => {
    if (!runtimeReadyRef.current || entry.adapter) return
    entry.adapter = createTerminalAdapter(sessionKey, forwardTerminalData, emitScrollState)
    entry.term = entry.adapter.term
    if (entry.container) openEntry(sessionKey, entry, entry.container)
  }, [emitScrollState, forwardTerminalData, openEntry])

  useEffect(() => {
    let cancelled = false
    ensureGhosttyReady()
      .then(() => {
        if (cancelled) return
        runtimeReadyRef.current = true
        for (const [sessionKey, entry] of entriesRef.current.entries()) {
          ensureAdapter(sessionKey, entry)
        }
      })
      .catch((err) => {
        console.error('Failed to initialize ghostty-web', err)
      })
    return () => {
      cancelled = true
    }
  }, [ensureAdapter])

  if (import.meta.env.DEV) {
    ;(window as Window & { __wt_terminals?: Map<SessionKey, TerminalEntry> }).__wt_terminals = entriesRef.current
  }

  const primeTerminal = useCallback((sessionKey: SessionKey) => {
    const entry = ensureEntry(sessionKey)
    ensureAdapter(sessionKey, entry)
    emitScrollState(sessionKey)
  }, [emitScrollState, ensureAdapter, ensureEntry])

  const ensureTerminal = useCallback((sessionKey: SessionKey, container: HTMLElement) => {
    const entry = ensureEntry(sessionKey)
    entry.container = container
    ensureAdapter(sessionKey, entry)
    if (entry.adapter && !entry.opened) {
      openEntry(sessionKey, entry, container)
    } else if (entry.adapter && entry.opened) {
      entry.adapter.fit()
      emitScrollState(sessionKey)
    }
  }, [emitScrollState, ensureAdapter, ensureEntry, openEntry])

  const setActive = useCallback((sessionKey: SessionKey) => {
    const prevId = activeIdRef.current
    if (prevId && prevId !== sessionKey) {
      const prev = entriesRef.current.get(prevId)
      if (prev) {
        prev.shouldBeActive = false
        prev.adapter?.blur()
      }
    }

    activeIdRef.current = sessionKey
    const entry = ensureEntry(sessionKey)
    entry.shouldBeActive = true
    ensureAdapter(sessionKey, entry)
    if (entry.adapter && entry.opened) {
      entry.adapter.fit()
      emitScrollState(sessionKey)
    }
  }, [emitScrollState, ensureAdapter, ensureEntry])

  const write = useCallback((sessionKey: SessionKey, data: Uint8Array, onFlushed?: () => void) => {
    const entry = ensureEntry(sessionKey)
    ensureAdapter(sessionKey, entry)
    if (!entry.adapter || !entry.opened) {
      entry.pendingWrites.push({ data: new Uint8Array(data), onFlushed })
      return
    }
    entry.adapter.write(data, () => {
      emitScrollState(sessionKey)
      onFlushed?.()
    })
  }, [emitScrollState, ensureAdapter, ensureEntry])

  const reset = useCallback((sessionKey: SessionKey) => {
    const entry = ensureEntry(sessionKey)
    entry.pendingWrites = []
    if (!entry.adapter || !entry.opened) {
      entry.pendingReset = true
      cbRef.current.onScrollStateChange(sessionKey, false)
      return
    }
    entry.adapter.reset()
    emitScrollState(sessionKey)
  }, [emitScrollState, ensureEntry])

  const scrollToBottom = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.adapter) return
    entry.adapter.scrollToBottom()
    emitScrollState(sessionKey)
  }, [emitScrollState])

  const focus = useCallback((sessionKey: SessionKey) => {
    const entry = ensureEntry(sessionKey)
    entry.pendingFocus = true
    entry.suppressFocusReportUntil = performance.now() + PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS
    if (entry.adapter && entry.opened) {
      entry.pendingFocus = false
      entry.adapter.focus()
    }
  }, [ensureEntry])

  const getDimensions = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    return entry?.adapter?.getDimensions() ?? { cols: 80, rows: 24 }
  }, [])

  const getMeasuredDimensions = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.adapter || !entry.opened) return null
    return entry.adapter.getMeasuredDimensions()
  }, [])

  const getApplicationCursorKeysMode = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.adapter || !entry.opened) return false
    return entry.adapter.getApplicationCursorKeysMode()
  }, [])

  const getBufferText = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry?.adapter) return ''
    return entry.adapter.getBufferText()
  }, [])

  const destroy = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    cbRef.current.onScrollStateChange(sessionKey, false)
    entry.ro?.disconnect()
    entry.momentumCleanup?.()
    entry.adapter?.dispose()
    entriesRef.current.delete(sessionKey)
    if (activeIdRef.current === sessionKey) activeIdRef.current = null
  }, [])

  return useMemo(
    () => ({ primeTerminal, ensureTerminal, setActive, write, reset, scrollToBottom, focus, getDimensions, getMeasuredDimensions, getApplicationCursorKeysMode, getBufferText, destroy }),
    [primeTerminal, ensureTerminal, setActive, write, reset, scrollToBottom, focus, getDimensions, getMeasuredDimensions, getApplicationCursorKeysMode, getBufferText, destroy],
  )
}
