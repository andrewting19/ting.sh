import type { SessionKey } from '../../types'
import type { TerminalSnapshot } from '../../snapshot/types'

export interface TerminalDimensions {
  cols: number
  rows: number
}

export interface TerminalScrollState {
  offsetFromTop: number
  offsetFromBottom: number
}

export interface TerminalBackendCallbacks {
  onData: (sessionKey: SessionKey, data: string) => void
  onScroll: (sessionKey: SessionKey) => void
  onResize: (sessionKey: SessionKey, cols: number, rows: number) => void
}

export interface TerminalBackendInstance {
  open: (container: HTMLElement) => void
  fit: () => void
  write: (data: Uint8Array, onFlushed?: () => void) => void
  restoreSnapshot?: (snapshot: TerminalSnapshot, onFlushed?: () => void) => boolean
  reset: () => void
  focus: () => void
  scrollToTop: () => void
  scrollToBottom: () => void
  setActive: (active: boolean) => void
  dispose: () => void
  isOpened: () => boolean
  getDimensions: () => TerminalDimensions
  getMeasuredDimensions: () => TerminalDimensions | null
  getScrollState: () => TerminalScrollState
  getApplicationCursorKeysMode: () => boolean
  getBufferText: (scope?: 'visible' | 'all') => string
}

export interface TerminalBackend {
  id: string
  init: () => Promise<void>
  createTerminal: (sessionKey: SessionKey, callbacks: TerminalBackendCallbacks) => TerminalBackendInstance
}

export interface TerminalBackendDebugInfo {
  term?: unknown
}

export interface DebuggableTerminalBackendInstance extends TerminalBackendInstance {
  getDebugInfo: () => TerminalBackendDebugInfo
}
