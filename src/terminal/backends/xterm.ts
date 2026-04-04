import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionKey } from '../../types'
import type { TerminalSnapshot } from '../../snapshot/types'
import type {
  DebuggableTerminalBackendInstance,
  TerminalBackend,
  TerminalBackendCallbacks,
  TerminalDimensions,
  TerminalScrollState,
} from './types'
import '@xterm/xterm/css/xterm.css'

const TERMINAL_OPTIONS = {
  fontSize: 13,
  lineHeight: 1.2,
  macOptionIsMeta: true,
  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
  cursorBlink: true,
  cursorStyle: 'block' as const,
  scrollback: 10000,
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

function isIOSDevice(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function isMobileDevice(): boolean {
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function attachIOSScroll(container: HTMLElement, term: Terminal): (() => void) | null {
  if (!isIOSDevice()) return null

  const prevTouchAction = container.style.touchAction
  container.style.touchAction = 'none'

  const cellHeight = () => (term.options.fontSize ?? 13) * (term.options.lineHeight ?? 1.2)

  const samples: { y: number; t: number }[] = []
  let lastY = 0
  let pixelRemainder = 0
  let rafId: number | null = null

  const cancelMomentum = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  const scrollByPixels = (deltaY: number) => {
    const ch = cellHeight()
    if (ch <= 0) return
    pixelRemainder += deltaY
    const lines = Math.trunc(pixelRemainder / ch)
    if (lines !== 0) {
      const before = term.buffer.active.viewportY
      term.scrollLines(lines)
      const after = term.buffer.active.viewportY
      pixelRemainder -= lines * ch
      if (before === after) pixelRemainder = 0
    }
  }

  const onTouchStart = (e: TouchEvent) => {
    cancelMomentum()
    pixelRemainder = 0
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
    if (deltaY !== 0) scrollByPixels(deltaY)
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
    pixelRemainder = 0
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

class XtermTerminalInstance implements DebuggableTerminalBackendInstance {
  private readonly term = new Terminal(TERMINAL_OPTIONS)
  private readonly fitAddon = new FitAddon()
  private webglAddon: WebglAddon | null = null
  private resizeObserver: ResizeObserver | null = null
  private momentumCleanup: (() => void) | null = null
  private opened = false
  private active = false

  constructor(
    private readonly sessionKey: SessionKey,
    private readonly callbacks: TerminalBackendCallbacks,
  ) {
    this.term.loadAddon(this.fitAddon)
    this.term.onData((data) => {
      this.callbacks.onData(this.sessionKey, data)
    })
    this.term.onScroll(() => {
      this.callbacks.onScroll(this.sessionKey)
    })
  }

  open(container: HTMLElement) {
    if (this.opened) return
    this.term.open(container)
    this.fitAddon.fit()
    this.momentumCleanup = attachIOSScroll(container, this.term)
    this.resizeObserver = new ResizeObserver(() => {
      this.fit()
      this.callbacks.onScroll(this.sessionKey)
      this.callbacks.onResize(this.sessionKey, this.term.cols, this.term.rows)
    })
    this.resizeObserver.observe(container)
    this.opened = true
  }

  fit() {
    this.fitAddon.fit()
  }

  write(data: Uint8Array, onFlushed?: () => void) {
    this.term.write(data, onFlushed)
  }

  restoreSnapshot(snapshot: TerminalSnapshot, onFlushed?: () => void) {
    if (snapshot.format !== 'xterm-vt-snapshot-v1') return false
    const shouldReloadWebgl = this.active && this.webglAddon !== null
    if (this.webglAddon) {
      this.webglAddon.dispose()
      this.webglAddon = null
    }
    this.term.reset()
    if (this.term.cols !== snapshot.cols || this.term.rows !== snapshot.rows) {
      this.term.resize(snapshot.cols, snapshot.rows)
    }
    this.term.write(snapshot.payload, () => {
      if (shouldReloadWebgl) this.setActive(true)
      onFlushed?.()
    })
    return true
  }

  reset() {
    this.term.reset()
  }

  focus() {
    this.term.focus()
  }

  scrollToBottom() {
    this.term.scrollToBottom()
  }

  scrollToTop() {
    this.term.scrollToTop()
  }

  setActive(active: boolean) {
    this.active = active
    if (!active) {
      this.webglAddon?.dispose()
      this.webglAddon = null
      return
    }

    if (!this.opened || this.webglAddon || isMobileDevice()) return
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        if (this.webglAddon === webgl) this.webglAddon = null
      })
      this.term.loadAddon(webgl)
      this.webglAddon = webgl
    } catch {
      // DOM renderer fallback is acceptable.
    }
  }

  dispose() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.momentumCleanup?.()
    this.momentumCleanup = null
    this.setActive(false)
    this.term.dispose()
  }

  isOpened() {
    return this.opened
  }

  getDimensions(): TerminalDimensions {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  getMeasuredDimensions(): TerminalDimensions | null {
    if (!this.opened || this.term.cols <= 0 || this.term.rows <= 0) return null
    return this.getDimensions()
  }

  getScrollState(): TerminalScrollState {
    const buffer = this.term.buffer.active
    return {
      offsetFromTop: buffer.viewportY,
      offsetFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
    }
  }

  getApplicationCursorKeysMode() {
    return this.term.modes.applicationCursorKeysMode ?? false
  }

  getBufferText() {
    const buffer = this.term.buffer.active
    let out = ''
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      if (i > 0 && !line.isWrapped) out += '\n'
      out += line.translateToString(true)
    }
    return out
  }

  getDebugInfo() {
    return { term: this.term }
  }
}

export function createXtermBackend(): TerminalBackend {
  return {
    id: 'xterm',
    init() {
      return Promise.resolve()
    },
    createTerminal(sessionKey, callbacks) {
      return new XtermTerminalInstance(sessionKey, callbacks)
    },
  }
}
