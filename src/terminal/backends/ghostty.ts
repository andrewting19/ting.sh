import { FitAddon, Terminal, init as initGhostty } from '@andrewting19/ghostty-web'
import type {
  DebuggableTerminalBackendInstance,
  TerminalBackend,
  TerminalBackendCallbacks,
  TerminalDimensions,
  TerminalScrollState,
} from './types'
import type { SessionKey } from '../../types'
import type { TerminalSnapshot } from '../../snapshot/types'
import { renderedTextSnapshotToVt, renderedTextSnapshotViewportLine } from '../../snapshot/renderedTextSnapshot'

const TERMINAL_OPTIONS = {
  fontSize: 13,
  lineHeight: 1.2,
  macOptionIsMeta: true,
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

let ghosttyInitPromise: Promise<void> | null = null

function ensureGhosttyReady(): Promise<void> {
  if (!ghosttyInitPromise) ghosttyInitPromise = initGhostty()
  return ghosttyInitPromise
}

function isIOSDevice(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function isIPad(): boolean {
  if (/iPad/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function shouldSuppressOpenAutoFocus(): boolean {
  if (typeof window === 'undefined') return false
  return isIOSDevice() || window.matchMedia('(max-width: 640px)').matches
}

function suppressGhosttyOpenFocus(container: HTMLElement, term: Terminal, previousActive: HTMLElement | null): void {
  const restoreOrBlur = () => {
    if (previousActive && previousActive !== document.body && previousActive !== container) {
      previousActive.focus({ preventScroll: true })
      return
    }

    term.blur()
    const focused = document.activeElement
    if (focused instanceof HTMLElement && container.contains(focused)) {
      focused.blur()
    }
  }

  restoreOrBlur()
  setTimeout(restoreOrBlur, 0)
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
  let pixelRemainder = 0
  let rafId: number | null = null

  const scrollByPixels = (deltaY: number) => {
    const lineHeight = getTerminalLineHeight(container, term)
    if (lineHeight <= 0) return
    pixelRemainder += deltaY
    const lines = Math.trunc(pixelRemainder / lineHeight)
    if (lines !== 0) {
      const before = term.getViewportY()
      term.scrollLines(lines)
      const after = term.getViewportY()
      pixelRemainder -= lines * lineHeight
      if (before === after) pixelRemainder = 0
    }
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
    pixelRemainder = 0
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

function hasGhosttyMouseTracking(term: Terminal): boolean {
  return term.getMode(1000, false) || term.getMode(1002, false) || term.getMode(1003, false)
}

/**
 * iPad trackpad two-finger scroll fix for ghostty.
 *
 * ghostty-web sets contenteditable="true" on the container div for keyboard
 * input.  On iPad Safari, trackpad two-finger scroll gestures on a focused
 * contenteditable element may be consumed by the editing/compositor layer
 * before wheel events reach JavaScript — so ghostty's built-in wheel handler
 * on the container never fires.
 *
 * Fix: attach a wheel listener directly on the <canvas> child (which is NOT
 * contenteditable).  Safari dispatches wheel events to the canvas normally,
 * and we translate them into scrollLines() calls ourselves.  We also keep
 * the customWheelEventHandler as a fallback for cases where wheel events DO
 * reach the container (e.g. future Safari fixes or mouse-wheel input).
 */
function attachIPadTrackpadScroll(container: HTMLElement, term: Terminal): (() => void) | null {
  if (!isIPad()) return null

  let pixelRemainder = 0

  const scrollWheel = (event: WheelEvent) => {
    if (hasGhosttyMouseTracking(term) || term.getScrollbackLength() <= 0) return

    const lineHeight = getTerminalLineHeight(container, term)
    if (lineHeight <= 0) return

    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()

    let deltaPixels = event.deltaY
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      deltaPixels *= lineHeight
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      deltaPixels *= lineHeight * term.rows
    }

    pixelRemainder += deltaPixels
    const lines = Math.trunc(pixelRemainder / lineHeight)
    if (lines !== 0) {
      term.scrollLines(lines)
      pixelRemainder -= lines * lineHeight
    }
  }

  // Listen on the canvas (not the contenteditable container) so the event
  // isn't swallowed by Safari's editing scroll path.  Capture phase ensures
  // we fire before ghostty-web's own handler (also capture) which is on the
  // container — a parent of the canvas.  Since we stopPropagation, the
  // container handler won't double-process.
  const options = { passive: false, capture: true } as const
  const targets = new Set<EventTarget>()
  targets.add(container)
  const canvas = container.querySelector('canvas')
  if (canvas) targets.add(canvas)
  const textarea = container.querySelector('textarea[aria-label="Terminal input"]')
  if (textarea) targets.add(textarea)

  for (const target of targets) {
    target.addEventListener('wheel', scrollWheel as EventListener, options)
  }

  return () => {
    pixelRemainder = 0
    for (const target of targets) {
      target.removeEventListener('wheel', scrollWheel as EventListener, options)
    }
  }
}

class GhosttyTerminalInstance implements DebuggableTerminalBackendInstance {
  private readonly term = new Terminal(TERMINAL_OPTIONS)
  private readonly fitAddon = new FitAddon()
  private resizeObserver: ResizeObserver | null = null
  private momentumCleanup: (() => void) | null = null
  private trackpadCleanup: (() => void) | null = null
  private opened = false

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
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.term.open(container)
    if (isIPad()) {
      const ta = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal input"]')
      if (ta) ta.readOnly = true
    }
    this.fitAddon.fit()
    this.momentumCleanup = attachIOSScroll(container, this.term)
    this.trackpadCleanup = attachIPadTrackpadScroll(container, this.term)
    this.resizeObserver = new ResizeObserver(() => {
      this.fit()
      this.callbacks.onScroll(this.sessionKey)
      this.callbacks.onResize(this.sessionKey, this.term.cols, this.term.rows)
    })
    this.resizeObserver.observe(container)
    this.opened = true

    // ghostty-web focuses during open(). On mobile, lazy-opening a pane after
    // refresh/session switch must not summon the keyboard; on desktop, opening
    // an inactive pane also should not steal focus from the active session.
    if (shouldSuppressOpenAutoFocus()) {
      suppressGhosttyOpenFocus(container, this.term, previousActive)
    } else if (previousActive && previousActive !== document.body && previousActive !== container) {
      previousActive.focus({ preventScroll: true })
    }
  }

  fit() {
    this.fitAddon.fit()
  }

  write(data: Uint8Array, onFlushed?: () => void) {
    this.term.write(data, onFlushed)
  }

  restoreSnapshot(snapshot: TerminalSnapshot, onFlushed?: () => void) {
    const isXtermVt = snapshot.format === 'xterm-vt-snapshot-v1'
    const isNormalRenderedText = snapshot.format === 'rendered-text-snapshot-v1' && snapshot.activeBuffer === 'normal'
    if (!isXtermVt && !isNormalRenderedText) return false

    this.term.reset()
    if (this.term.cols !== snapshot.cols || this.term.rows !== snapshot.rows) {
      this.term.resize(snapshot.cols, snapshot.rows)
    }

    if (isXtermVt) {
      this.term.write(snapshot.payload, () => {
        if (snapshot.normalViewportY > 0) this.term.scrollToLine(snapshot.normalViewportY)
        onFlushed?.()
      })
      return true
    }

    this.term.write(renderedTextSnapshotToVt(snapshot), () => {
      const viewportLine = renderedTextSnapshotViewportLine(snapshot)
      if (viewportLine !== null) this.term.scrollToLine(viewportLine)
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

  scrollToTop() {
    this.term.scrollToTop()
  }

  scrollToBottom() {
    this.term.scrollToBottom()
  }

  setActive(active: boolean) {
    if (!active) {
      this.term.blur()
      this.term.pauseRendering()
      return
    }
    this.term.resumeRendering()
  }

  dispose() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.momentumCleanup?.()
    this.momentumCleanup = null
    this.trackpadCleanup?.()
    this.trackpadCleanup = null
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
    const offsetFromBottom = Math.max(0, Math.floor(this.term.getViewportY()))
    const scrollbackLength = this.term.getScrollbackLength()
    return {
      offsetFromTop: Math.max(0, scrollbackLength - offsetFromBottom),
      offsetFromBottom,
    }
  }

  getApplicationCursorKeysMode() {
    return this.term.getMode(1, false)
  }

  getBracketedPasteMode() {
    return this.term.getMode(2004, false)
  }

  getBufferText(scope: 'visible' | 'all' = 'all') {
    const buffer = this.term.buffer.active
    const start = scope === 'visible' ? buffer.viewportY : 0
    const end = scope === 'visible'
      ? Math.min(buffer.length, buffer.viewportY + this.term.rows)
      : buffer.length
    const parts: string[] = []
    for (let i = start; i < end; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      if (i > start && !line.isWrapped) parts.push('\n')
      parts.push(line.translateToString(true))
    }
    return parts.join('')
  }

  getDebugInfo() {
    return { term: this.term }
  }
}

export function createGhosttyBackend(): TerminalBackend {
  return {
    id: 'ghostty',
    init() {
      return ensureGhosttyReady()
    },
    createTerminal(sessionKey, callbacks) {
      return new GhosttyTerminalInstance(sessionKey, callbacks)
    },
  }
}
