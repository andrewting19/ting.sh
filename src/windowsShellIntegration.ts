const WINDOWS_CWD_OSC_PREFIX = "\u001b]633;P;Cwd="

export function normalizeWindowsPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (/^\/[a-zA-Z]\//.test(trimmed)) {
    return `${trimmed[1].toUpperCase()}:/${trimmed.slice(3)}`.replace(/\\/g, '/')
  }

  return trimmed.replace(/\\/g, '/')
}

export function isGitBashShell(shell: string): boolean {
  const normalized = normalizeWindowsPath(shell).toLowerCase()
  return normalized.endsWith('/git/bin/bash.exe') || normalized.endsWith('/git/usr/bin/bash.exe')
}

export function buildGitBashPromptCommand(existing?: string): string {
  const hook = '__ting_emit_cwd(){ local __ting_cwd; __ting_cwd="$(pwd -W 2>/dev/null || pwd)"; printf "\\033]633;P;Cwd=%s\\007" "$__ting_cwd"; }'
  const invoke = '__ting_emit_cwd'
  const prior = existing?.trim()
  return prior ? `${hook}; ${invoke}; ${prior}` : `${hook}; ${invoke}`
}

export function stripWindowsCwdControlFrames(
  data: Uint8Array,
  remainder = '',
): { data: Uint8Array; cwd: string | null; remainder: string } {
  const text = remainder + Buffer.from(data).toString('latin1')
  const output: string[] = []
  let nextCwd: string | null = null
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf(WINDOWS_CWD_OSC_PREFIX, cursor)
    if (start === -1) {
      output.push(text.slice(cursor))
      return {
        data: Buffer.from(output.join(''), 'latin1'),
        cwd: nextCwd,
        remainder: '',
      }
    }

    output.push(text.slice(cursor, start))
    const end = text.indexOf('\u0007', start + WINDOWS_CWD_OSC_PREFIX.length)
    if (end === -1) {
      return {
        data: Buffer.from(output.join(''), 'latin1'),
        cwd: nextCwd,
        remainder: text.slice(start),
      }
    }

    const rawCwd = text.slice(start + WINDOWS_CWD_OSC_PREFIX.length, end)
    const normalized = normalizeWindowsPath(rawCwd)
    if (normalized) nextCwd = normalized
    cursor = end + 1
  }

  return {
    data: Buffer.from(output.join(''), 'latin1'),
    cwd: nextCwd,
    remainder: '',
  }
}
