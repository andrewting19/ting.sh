const WINDOWS_CWD_OSC_PREFIX = "\u001b]633;P;Cwd="

export interface WindowsSessionIdentity {
  user?: string
  home?: string
}

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

export function isWindowsServiceAccountUser(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'system'
    || normalized === 'localsystem'
    || normalized === 'localservice'
    || normalized === 'networkservice'
}

export function isWindowsServiceProfileHome(value: string | null | undefined): boolean {
  const normalized = normalizeWindowsPath(value ?? '').toLowerCase()
  return normalized.endsWith('/windows/system32/config/systemprofile')
    || normalized.endsWith('/windows/serviceprofiles/localservice')
    || normalized.endsWith('/windows/serviceprofiles/networkservice')
}

export function resolveWindowsSessionIdentityFromEnv(
  env: Record<string, string | undefined>,
): WindowsSessionIdentity {
  const user = env.TING_WINDOWS_SESSION_USER?.trim()
    || env.USER?.trim()
    || env.LOGNAME?.trim()
    || env.USERNAME?.trim()
    || undefined

  const homeCandidate = env.TING_WINDOWS_SESSION_HOME
    || env.HOME
    || env.USERPROFILE
    || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
  const home = homeCandidate ? normalizeWindowsPath(homeCandidate) : undefined

  return {
    user,
    home: home || undefined,
  }
}

function splitWindowsHome(home: string): { drive?: string; path?: string } {
  const normalized = normalizeWindowsPath(home)
  const match = normalized.match(/^([a-zA-Z]:)(\/.*)?$/)
  if (!match) {
    return {}
  }

  return {
    drive: match[1],
    path: (match[2] || '/').replace(/\//g, '\\'),
  }
}

export function applyWindowsSessionIdentity(
  env: Record<string, string>,
  identity: WindowsSessionIdentity,
): Record<string, string> {
  const next = { ...env }

  const home = identity.home?.trim() ? normalizeWindowsPath(identity.home) : ''
  if (home) {
    const homeWindows = home.replace(/\//g, '\\')
    next.HOME = home
    next.USERPROFILE = homeWindows

    const splitHome = splitWindowsHome(home)
    if (splitHome.drive) next.HOMEDRIVE = splitHome.drive
    if (splitHome.path) next.HOMEPATH = splitHome.path
  }

  return next
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
