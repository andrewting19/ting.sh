import type { TerminalBackend } from './types'
import { createGhosttyBackend } from './ghostty'
import { createXtermBackend } from './xterm'

export type TerminalRenderer = 'xterm' | 'ghostty'

export function createTerminalBackend(renderer: TerminalRenderer = 'xterm'): TerminalBackend {
  return renderer === 'ghostty' ? createGhosttyBackend() : createXtermBackend()
}
