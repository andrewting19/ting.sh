import { useRef, useCallback, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalEntry {
  term: Terminal
  fitAddon: FitAddon
  webglAddon: WebglAddon | null
  ro: ResizeObserver
  // False until term.open(container) is called. A terminal can be primed
  // (created without a container) so it buffers incoming binary before the
  // container div exists in the DOM.
  opened: boolean
  // Cleanup fn for iOS momentum scroll listeners; null on non-iOS.
  momentumCleanup: (() => void) | null
}

interface Callbacks {
  onData: (sessionId: string, data: string) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
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

// iOS Safari scroll fix for xterm.js.
//
// Root cause: xterm.js registers touchstart with {passive:true}, so it can
// never call preventDefault(). iOS therefore fires synthetic mouse events
// (mousedown → mouseup → click) after every touch ends. xterm.js has a
// mousedown handler that activates its selection-tracking state machine.
// Once selection mode activates mid-gesture, subsequent touches get partially
// consumed by selection logic instead of the scroll handler — causing the
// "scroll sometimes stops registering" bug.
//
// Fix:
//   1. Track whether the gesture moved >5px (i.e. is a scroll, not a tap).
//   2. touchend is non-passive so we CAN call preventDefault():
//      - Scroll gesture: preventDefault() suppresses the synthetic mousedown
//        → xterm.js selection mode never activates → reliable scroll +
//        momentum animation.
//      - Tap gesture: no preventDefault → synthetic mousedown fires normally
//        → xterm.js focuses its textarea → iOS keyboard appears.
//   3. capture:true on all listeners so xterm.js's stopPropagation() calls
//      in bubble phase never affect us.
//   4. We never call stopPropagation() — xterm.js keeps all events and
//      drives the live per-frame scroll itself. We only add momentum after
//      touchend when xterm.js is idle.
function attachIOSScroll(container: HTMLElement): (() => void) | null {
  if (!/iPhone|iPad|iPod/i.test(navigator.userAgent)) return null

  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null
  if (!viewport) return null

  const SCROLL_THRESHOLD_PX = 5
  const samples: { y: number; t: number }[] = []
  let startY = 0
  let isScrollGesture = false
  let rafId: number | null = null

  const cancelMomentum = () => {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
  }

  const onTouchStart = (e: TouchEvent) => {
    cancelMomentum()
    samples.length = 0
    isScrollGesture = false
    startY = e.touches[0].pageY
    samples.push({ y: startY, t: performance.now() })
  }

  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    const y = e.touches[0].pageY
    if (!isScrollGesture && Math.abs(y - startY) > SCROLL_THRESHOLD_PX) {
      isScrollGesture = true
    }
    samples.push({ y, t: performance.now() })
    if (samples.length > 8) samples.shift()
  }

  const onTouchEnd = (e: TouchEvent) => {
    if (!isScrollGesture) return  // tap — let synthetic mousedown through for keyboard/focus

    // Suppress synthetic mousedown so xterm.js selection mode never activates
    e.preventDefault()

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
    isScrollGesture = false
  }

  const capturePassive = { capture: true, passive: true } as const
  const captureActive  = { capture: true, passive: false } as const
  container.addEventListener('touchstart',  onTouchStart,  capturePassive)
  container.addEventListener('touchmove',   onTouchMove,   capturePassive)
  container.addEventListener('touchend',    onTouchEnd,    captureActive)   // needs preventDefault
  container.addEventListener('touchcancel', onTouchCancel, capturePassive)

  return () => {
    cancelMomentum()
    container.removeEventListener('touchstart',  onTouchStart,  capturePassive)
    container.removeEventListener('touchmove',   onTouchMove,   capturePassive)
    container.removeEventListener('touchend',    onTouchEnd,    captureActive)
    container.removeEventListener('touchcancel', onTouchCancel, capturePassive)
  }
}

export function useTerminalManager(callbacks: Callbacks) {
  const entriesRef = useRef<Map<string, TerminalEntry>>(new Map())

  // Expose terminal entries on window in dev mode so Playwright tests can
  // read terminal buffer content without scraping the canvas.
  if (import.meta.env.DEV) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__wt_terminals = entriesRef.current
  }
  const activeIdRef = useRef<string | null>(null)
  // Always-fresh callbacks via ref — no stale closure issues
  const cbRef = useRef(callbacks)
  cbRef.current = callbacks

  // Create a Terminal instance without opening it (no container yet).
  // xterm.js processes write() calls into its internal VT buffer even before
  // open() is called, so binary that arrives before React re-renders (and
  // the container div appears) is captured rather than dropped.
  // Called from the 'ready' handler in App.tsx for 'create' flows.
  const primeTerminal = useCallback((sessionId: string) => {
    if (entriesRef.current.has(sessionId)) return

    const term = new Terminal(TERMINAL_OPTIONS)
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    term.onData((data) => {
      if (activeIdRef.current === sessionId) cbRef.current.onData(sessionId, data)
    })

    // Stub RO — replaced with the real one when open() is called in ensureTerminal
    const ro = new ResizeObserver(() => {})
    entriesRef.current.set(sessionId, { term, fitAddon, webglAddon: null, ro, opened: false, momentumCleanup: null })
  }, [])

  const ensureTerminal = useCallback((sessionId: string, container: HTMLElement) => {
    const existing = entriesRef.current.get(sessionId)

    if (existing) {
      if (!existing.opened) {
        // Terminal was primed (buffering data); now we have a container — open it.
        existing.term.open(container)
        existing.fitAddon.fit()
        existing.opened = true
        existing.momentumCleanup = attachIOSScroll(container)
        // Replace stub RO with real one that reacts to container size changes
        existing.ro.disconnect()
        const ro = new ResizeObserver(() => {
          existing.fitAddon.fit()
          cbRef.current.onResize(sessionId, existing.term.cols, existing.term.rows)
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
    term.open(container)
    fitAddon.fit()

    term.onData((data) => {
      if (activeIdRef.current === sessionId) cbRef.current.onData(sessionId, data)
    })

    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      cbRef.current.onResize(sessionId, term.cols, term.rows)
    })
    ro.observe(container)

    entriesRef.current.set(sessionId, { term, fitAddon, webglAddon: null, ro, opened: true, momentumCleanup: attachIOSScroll(container) })
  }, [])

  // Switch the WebGL renderer to the newly active terminal.
  // Inactive terminals don't need GPU acceleration — they're invisible.
  const setActive = useCallback((sessionId: string) => {
    const prevId = activeIdRef.current

    // Dispose WebGL from previous terminal
    if (prevId && prevId !== sessionId) {
      const prev = entriesRef.current.get(prevId)
      if (prev?.webglAddon) {
        prev.webglAddon.dispose()
        prev.webglAddon = null
      }
    }

    activeIdRef.current = sessionId

    // Load WebGL on newly active terminal (skip on mobile — fails silently on iOS Safari)
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    const entry = entriesRef.current.get(sessionId)
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
    if (entry?.opened) entry.fitAddon.fit()
  }, [])

  const write = useCallback((sessionId: string, data: Uint8Array) => {
    entriesRef.current.get(sessionId)?.term.write(data)
  }, [])

  const reset = useCallback((sessionId: string) => {
    entriesRef.current.get(sessionId)?.term.reset()
  }, [])

  const focus = useCallback((sessionId: string) => {
    entriesRef.current.get(sessionId)?.term.focus()
  }, [])

  const getDimensions = useCallback((sessionId: string) => {
    const term = entriesRef.current.get(sessionId)?.term
    return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 }
  }, [])

  const destroy = useCallback((sessionId: string) => {
    const entry = entriesRef.current.get(sessionId)
    if (!entry) return
    entry.ro.disconnect()
    entry.momentumCleanup?.()
    entry.webglAddon?.dispose()
    entry.term.dispose()
    entriesRef.current.delete(sessionId)
    if (activeIdRef.current === sessionId) activeIdRef.current = null
  }, [])

  // useMemo so the returned object has a stable reference across renders.
  // All functions are useCallback([]) so their refs never change, which means
  // this memo never re-computes. Without this, effects in App.tsx that list
  // `tm` as a dep would re-fire on every render and send spurious WS messages.
  return useMemo(
    () => ({ primeTerminal, ensureTerminal, setActive, write, reset, focus, getDimensions, destroy }),
    [primeTerminal, ensureTerminal, setActive, write, reset, focus, getDimensions, destroy]
  )
}
