import type { TerminalBackend } from './types'
import { createXtermBackend } from './xterm'

let backend: TerminalBackend | null = null

export function getTerminalBackend(): TerminalBackend {
  if (!backend) backend = createXtermBackend()
  return backend
}
