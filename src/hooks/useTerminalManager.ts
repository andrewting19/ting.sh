import { useRef, useCallback, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionKey } from '../types'
import '@xterm/xterm/css/xterm.css'

interface TerminalEntry {
  term: Terminal
  fitAddon: FitAddon
  canvasAddon: CanvasAddon | null
  webglAddon: WebglAddon | null
  ro: ResizeObserver
  // False until term.open(container) is called. A terminal can be primed
  // (created without a container) so it buffers incoming binary before the
  // container div exists in the DOM.
  opened: boolean
  // Cleanup fn for iOS momentum scroll listeners; null on non-iOS.
  momentumCleanup: (() => void) | null
  // Safari/iOS canvas renderer can occasionally leave stale glyphs for one
  // frame during rapid redraw + scroll. Coalesce full repaints to the next rAF.
  fullRefreshRaf: number | null
  // Programmatic term.focus() can emit CSI I/O when an app enabled focus
  // reporting (?1004h). Suppress only the immediate focus/blur report so the
  // shell prompt doesn't get literal "^[[I" inserted during session switches.
  suppressFocusReportUntil: number
}

interface Callbacks {
  onData: (sessionKey: SessionKey, data: string) => void
  onResize: (sessionKey: SessionKey, cols: number, rows: number) => void
}

const TERMINAL_OPTIONS = {
  fontSize: 13,
  lineHeight: 1.2,
  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
  cursorBlink: true,
  cursorStyle: 'block' as const,
  scrollback: 10000,
  theme: {
    background:    '#0d0e17',
    foreground:    '#c0caf5',
    cursor:        '#c0caf5',
    cursorAccent:  '#0d0e17',
    selectionBackground: '#283457',
    black:         '#15161e',
    red:           '#f7768e',
    green:         '#9ece6a',
    yellow:        '#e0af68',
    blue:          '#7aa2f7',
    magenta:       '#bb9af7',
    cyan:          '#7dcfff',
    white:         '#a9b1d6',
    brightBlack:   '#414868',
    brightRed:     '#f7768e',
    brightGreen:   '#9ece6a',
    brightYellow:  '#e0af68',
    brightBlue:    '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan:    '#7dcfff',
    brightWhite:   '#c0caf5',
  },
}

const PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS = 150

function isIOSDevice(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  // iPadOS with desktop-site UA reports MacIntel plus touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function isMobileDevice(): boolean {
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

// iOS touch scrolling with momentum. We intentionally own touchmove + scrollTop
// here so xterm's internal handler can't double-apply deltas.
function attachIOSScroll(container: HTMLElement): (() => void) | null {
  if (!isIOSDevice()) return null

  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null
  if (!viewport) return null

  const prevOverflow = viewport.style.overflow
  const prevTouchAction = viewport.style.touchAction
  // Kill native scrolling in this viewport; we drive scrollTop ourselves.
  viewport.style.overflow = 'hidden'
  viewport.style.touchAction = 'none'

  const samples: { y: number; t: number }[] = []
  let lastY = 0
  let rafId: number | null = null

  const cancelMomentum = () => {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
  }

  const onTouchStart = (e: TouchEvent) => {
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
    if (deltaY !== 0) viewport.scrollTop += deltaY
    samples.push({ y, t: performance.now() })
    if (samples.length > 8) samples.shift()
    // Prevent xterm's own touchmove handler from double-scrolling.
    e.stopPropagation()
  }

  const onTouchEnd = (e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (samples.length < 2) return
    const last = samples[samples.length - 1]
    const prev = samples[samples.length - 2]
    const dt = last.t - prev.t
    if (dt <= 0 || dt > 100) return  // finger was stationary before lifting

    let velocity = (prev.y - last.y) / dt  // px/ms; positive = scroll down
    if (Math.abs(velocity) < 0.1) return

    let prevFrame = performance.now()
    const animate = (now: number) => {
      const elapsed = Math.min(now - prevFrame, 32)
      prevFrame = now
      if (Math.abs(velocity) < 0.05) { rafId = null; return }
      viewport.scrollTop += velocity * elapsed
      velocity *= Math.pow(0.94, elapsed / 16.67)  // friction, normalised to 60fps
      rafId = requestAnimationFrame(animate)
    }
    rafId = requestAnimationFrame(animate)
  }

  const onTouchCancel = () => {
    cancelMomentum()
    samples.length = 0
    lastY = 0
  }

  const captureActive  = { capture: true, passive: false } as const
  const capturePassive = { capture: true, passive: true  } as const
  container.addEventListener('touchstart',  onTouchStart,  captureActive)
  container.addEventListener('touchmove',   onTouchMove,   captureActive)
  container.addEventListener('touchend',    onTouchEnd,    captureActive)
  container.addEventListener('touchcancel', onTouchCancel, capturePassive)

  return () => {
    cancelMomentum()
    viewport.style.overflow = prevOverflow
    viewport.style.touchAction = prevTouchAction
    container.removeEventListener('touchstart',  onTouchStart,  captureActive)
    container.removeEventListener('touchmove',   onTouchMove,   captureActive)
    container.removeEventListener('touchend',    onTouchEnd,    captureActive)
    container.removeEventListener('touchcancel', onTouchCancel, capturePassive)
  }
}

export function useTerminalManager(callbacks: Callbacks) {
  const entriesRef = useRef<Map<SessionKey, TerminalEntry>>(new Map())
  const scheduleFullRefresh = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry || !entry.opened || !entry.canvasAddon) return
    if (!isIOSDevice()) return
    if (entry.fullRefreshRaf !== null) return

    entry.fullRefreshRaf = requestAnimationFrame(() => {
      entry.fullRefreshRaf = null
      // Only repaint the visible terminal to avoid extra work on hidden panes.
      if (activeIdRef.current !== sessionKey) return
      const rows = entry.term.rows
      if (rows > 0) entry.term.refresh(0, rows - 1)
    })
  }, [])

  // Expose terminal entries on window in dev mode so Playwright tests can
  // read terminal buffer content without scraping the canvas.
  if (import.meta.env.DEV) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__wt_terminals = entriesRef.current
  }
  const activeIdRef = useRef<SessionKey | null>(null)
  // Always-fresh callbacks via ref — no stale closure issues
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks
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

    const term = new Terminal(TERMINAL_OPTIONS)
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    let canvasAddon: CanvasAddon | null = null
    if (isIOSDevice()) {
      canvasAddon = new CanvasAddon()
      term.loadAddon(canvasAddon)
    }

    term.onData((data) => {
      forwardTerminalData(sessionKey, data)
    })

    // Stub RO — replaced with the real one when open() is called in ensureTerminal
    const ro = new ResizeObserver(() => {})
    entriesRef.current.set(sessionKey, { term, fitAddon, canvasAddon, webglAddon: null, ro, opened: false, momentumCleanup: null, fullRefreshRaf: null, suppressFocusReportUntil: 0 })
  }, [forwardTerminalData])

  const ensureTerminal = useCallback((sessionKey: SessionKey, container: HTMLElement) => {
    const existing = entriesRef.current.get(sessionKey)

    if (existing) {
      if (!existing.opened) {
        // Terminal was primed (buffering data); now we have a container — open it.
        existing.term.open(container)
        existing.fitAddon.fit()
        existing.opened = true
        scheduleFullRefresh(sessionKey)
        existing.momentumCleanup = attachIOSScroll(container)
        // Replace stub RO with real one that reacts to container size changes
        existing.ro.disconnect()
        const ro = new ResizeObserver(() => {
          existing.fitAddon.fit()
          scheduleFullRefresh(sessionKey)
          cbRef.current.onResize(sessionKey, existing.term.cols, existing.term.rows)
        })
        ro.observe(container)
        existing.ro = ro
      }
      return
    }

    // No prior entry — create and open in one shot
    const term = new Terminal(TERMINAL_OPTIONS)
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    let canvasAddon: CanvasAddon | null = null
    if (isIOSDevice()) {
      canvasAddon = new CanvasAddon()
      term.loadAddon(canvasAddon)
    }
    term.open(container)
    fitAddon.fit()
    scheduleFullRefresh(sessionKey)

    term.onData((data) => {
      forwardTerminalData(sessionKey, data)
    })

    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      scheduleFullRefresh(sessionKey)
      cbRef.current.onResize(sessionKey, term.cols, term.rows)
    })
    ro.observe(container)

    entriesRef.current.set(sessionKey, { term, fitAddon, canvasAddon, webglAddon: null, ro, opened: true, momentumCleanup: attachIOSScroll(container), fullRefreshRaf: null, suppressFocusReportUntil: 0 })
    scheduleFullRefresh(sessionKey)
  }, [forwardTerminalData, scheduleFullRefresh])

  // Switch the WebGL renderer to the newly active terminal.
  // Inactive terminals don't need GPU acceleration — they're invisible.
  const setActive = useCallback((sessionKey: SessionKey) => {
    const prevId = activeIdRef.current

    // Dispose WebGL from previous terminal
    if (prevId && prevId !== sessionKey) {
      const prev = entriesRef.current.get(prevId)
      if (prev?.webglAddon) {
        prev.webglAddon.dispose()
        prev.webglAddon = null
      }
    }

    activeIdRef.current = sessionKey

    // Load WebGL on newly active terminal (skip on mobile — fails silently on iOS Safari)
    const isMobile = isMobileDevice()
    const entry = entriesRef.current.get(sessionKey)
    if (entry && entry.opened && !entry.webglAddon && !isMobile) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => { webgl.dispose(); entry.webglAddon = null })
        entry.term.loadAddon(webgl)
        entry.webglAddon = webgl
      } catch {
        // Canvas fallback — fine
      }
    }

    // Re-fit in case the container was invisible when last resized
    if (entry?.opened) {
      entry.fitAddon.fit()
      scheduleFullRefresh(sessionKey)
    }
  }, [scheduleFullRefresh])

  const write = useCallback((sessionKey: SessionKey, data: Uint8Array, onFlushed?: () => void) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.term.write(data, () => {
      scheduleFullRefresh(sessionKey)
      onFlushed?.()
    })
  }, [scheduleFullRefresh])

  const reset = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.term.reset()
    scheduleFullRefresh(sessionKey)
  }, [scheduleFullRefresh])

  const scrollToBottom = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.term.scrollToBottom()
    scheduleFullRefresh(sessionKey)
  }, [scheduleFullRefresh])

  const focus = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.suppressFocusReportUntil = performance.now() + PROGRAMMATIC_FOCUS_REPORT_SUPPRESS_MS
    entry.term.focus()
  }, [])

  const getDimensions = useCallback((sessionKey: SessionKey) => {
    const term = entriesRef.current.get(sessionKey)?.term
    return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 }
  }, [])

  const getApplicationCursorKeysMode = useCallback((sessionKey: SessionKey) => {
    return entriesRef.current.get(sessionKey)?.term.modes.applicationCursorKeysMode ?? false
  }, [])

  const destroy = useCallback((sessionKey: SessionKey) => {
    const entry = entriesRef.current.get(sessionKey)
    if (!entry) return
    entry.ro.disconnect()
    entry.momentumCleanup?.()
    if (entry.fullRefreshRaf !== null) {
      cancelAnimationFrame(entry.fullRefreshRaf)
      entry.fullRefreshRaf = null
    }
    entry.webglAddon?.dispose()
    entry.canvasAddon?.dispose()
    entry.term.dispose()
    entriesRef.current.delete(sessionKey)
    if (activeIdRef.current === sessionKey) activeIdRef.current = null
  }, [])

  // useMemo so the returned object has a stable reference across renders.
  // All functions are useCallback([]) so their refs never change, which means
  // this memo never re-computes. Without this, effects in App.tsx that list
  // `tm` as a dep would re-fire on every render and send spurious WS messages.
  return useMemo(
    () => ({ primeTerminal, ensureTerminal, setActive, write, reset, scrollToBottom, focus, getDimensions, getApplicationCursorKeysMode, destroy }),
    [primeTerminal, ensureTerminal, setActive, write, reset, scrollToBottom, focus, getDimensions, getApplicationCursorKeysMode, destroy]
  )
}
