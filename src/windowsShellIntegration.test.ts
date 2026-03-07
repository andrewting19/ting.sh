import { expect, test } from 'bun:test'
import {
  applyWindowsSessionIdentity,
  buildGitBashPromptCommand,
  isGitBashShell,
  isWindowsServiceAccountUser,
  isWindowsServiceProfileHome,
  normalizeWindowsPath,
  resolveWindowsSessionIdentityFromEnv,
  stripWindowsCwdControlFrames,
} from './windowsShellIntegration'

test('normalizeWindowsPath converts git-bash style cwd to Windows form', () => {
  expect(normalizeWindowsPath('/c/Users/Andrew')).toBe('C:/Users/Andrew')
  expect(normalizeWindowsPath('C:\\Users\\Andrew')).toBe('C:/Users/Andrew')
})

test('isGitBashShell detects common Git for Windows shell paths', () => {
  expect(isGitBashShell('C:/Program Files/Git/bin/bash.exe')).toBe(true)
  expect(isGitBashShell('C:/Program Files/Git/usr/bin/bash.exe')).toBe(true)
  expect(isGitBashShell('C:/Windows/System32/cmd.exe')).toBe(false)
})

test('resolveWindowsSessionIdentityFromEnv prefers explicit ting session overrides', () => {
  const identity = resolveWindowsSessionIdentityFromEnv({
    TING_WINDOWS_SESSION_USER: 'Andrew',
    TING_WINDOWS_SESSION_HOME: 'C:\\Users\\Andrew',
    USERNAME: 'SYSTEM',
    USERPROFILE: 'C:\\Windows\\System32\\config\\systemprofile',
  })

  expect(identity).toEqual({
    user: 'Andrew',
    home: 'C:/Users/Andrew',
  })
})

test('applyWindowsSessionIdentity populates shell home env', () => {
  const env = applyWindowsSessionIdentity(
    { TERM: 'xterm-256color' },
    { user: 'Andrew', home: 'C:/Users/Andrew' },
  )

  expect(env).toMatchObject({
    TERM: 'xterm-256color',
    HOME: 'C:/Users/Andrew',
    USERPROFILE: 'C:\\Users\\Andrew',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\Andrew',
  })
})

test('service account helpers detect Windows service identities', () => {
  expect(isWindowsServiceAccountUser('LocalSystem')).toBe(true)
  expect(isWindowsServiceAccountUser('Andrew')).toBe(false)
  expect(isWindowsServiceProfileHome('C:\\Windows\\System32\\config\\systemprofile')).toBe(true)
  expect(isWindowsServiceProfileHome('C:/Users/Andrew')).toBe(false)
})

test('buildGitBashPromptCommand preserves existing prompt hooks', () => {
  const command = buildGitBashPromptCommand('echo existing')
  expect(command).toContain('__ting_emit_cwd')
  expect(command).toContain('echo existing')
})

test('stripWindowsCwdControlFrames removes OSC metadata and extracts cwd', () => {
  const input = Buffer.from('\u001b]633;P;Cwd=C:/Users/Andrew\u0007hello', 'latin1')
  const result = stripWindowsCwdControlFrames(input)
  expect(Buffer.from(result.data).toString('latin1')).toBe('hello')
  expect(result.cwd).toBe('C:/Users/Andrew')
  expect(result.remainder).toBe('')
})

test('stripWindowsCwdControlFrames handles split OSC frames across chunks', () => {
  const first = Buffer.from('\u001b]633;P;Cwd=C:/Users', 'latin1')
  const second = Buffer.from('/Andrew\u0007ok', 'latin1')
  const step1 = stripWindowsCwdControlFrames(first)
  expect(Buffer.from(step1.data).toString('latin1')).toBe('')
  expect(step1.cwd).toBeNull()
  expect(step1.remainder).toContain('C:/Users')

  const step2 = stripWindowsCwdControlFrames(second, step1.remainder)
  expect(Buffer.from(step2.data).toString('latin1')).toBe('ok')
  expect(step2.cwd).toBe('C:/Users/Andrew')
  expect(step2.remainder).toBe('')
})
