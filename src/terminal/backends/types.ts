import type { SessionKey } from '../../types'

export interface TerminalDimensions {
  cols: number
  rows: number
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
  reset: () => void
  focus: () => void
  scrollToBottom: () => void
  setActive: (active: boolean) => void
  dispose: () => void
  isOpened: () => boolean
  getDimensions: () => TerminalDimensions
  getMeasuredDimensions: () => TerminalDimensions | null
  getApplicationCursorKeysMode: () => boolean
  getBufferText: () => string
  getLinesFromBottom: () => number
}

export interface TerminalBackend {
  id: string
  createTerminal: (sessionKey: SessionKey, callbacks: TerminalBackendCallbacks) => TerminalBackendInstance
}

export interface TerminalBackendDebugInfo {
  term?: unknown
}

export interface DebuggableTerminalBackendInstance extends TerminalBackendInstance {
  getDebugInfo: () => TerminalBackendDebugInfo
}
