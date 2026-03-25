import type { TerminalBackend } from './types'
import { createXtermBackend } from './xterm'

export function createTerminalBackend(): TerminalBackend {
  return createXtermBackend()
}
