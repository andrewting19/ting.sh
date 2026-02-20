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

  const ensureTerminal = useCallback((sessionId: string, container: HTMLElement) => {
    if (entriesRef.current.has(sessionId)) return

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

    entriesRef.current.set(sessionId, { term, fitAddon, webglAddon: null, ro })
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
    if (entry && !entry.webglAddon && !isMobile) {
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
    entry?.fitAddon.fit()
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
    entry.webglAddon?.dispose()
    entry.term.dispose()
    entriesRef.current.delete(sessionId)
    if (activeIdRef.current === sessionId) activeIdRef.current = null
  }, [])

  // useMemo so the returned object has a stable reference across renders.
  // All seven functions are useCallback([]) so their refs never change,
  // which means this memo never re-computes. Without this, effects in
  // App.tsx that list `tm` as a dep would re-fire on every render and
  // send spurious attach/list requests in an infinite loop.
  return useMemo(
    () => ({ ensureTerminal, setActive, write, reset, focus, getDimensions, destroy }),
    [ensureTerminal, setActive, write, reset, focus, getDimensions, destroy]
  )
}
