import type { TerminalRenderer } from './backends'

export const TERMINAL_RENDERER_STORAGE_KEY = 'wt-terminal-renderer'

function isTerminalRenderer(value: unknown): value is TerminalRenderer {
  return value === 'xterm' || value === 'ghostty'
}

export function getStoredTerminalRenderer(): TerminalRenderer | null {
  try {
    const value = localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY)
    return isTerminalRenderer(value) ? value : null
  } catch {
    return null
  }
}

export function resolveTerminalRenderer(): TerminalRenderer {
  const stored = getStoredTerminalRenderer()
  if (stored) return stored

  const envValue = import.meta.env.VITE_TERMINAL_RENDERER
  return isTerminalRenderer(envValue) ? envValue : 'xterm'
}

export function persistTerminalRenderer(renderer: TerminalRenderer): void {
  localStorage.setItem(TERMINAL_RENDERER_STORAGE_KEY, renderer)
}
