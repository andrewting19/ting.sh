import type { Page } from '@playwright/test'

/** IDs of all session items currently visible in the sidebar. */
export async function getSessions(page: Page): Promise<string[]> {
  return page.$$eval('[data-session-id]', els =>
    els.map(el => el.getAttribute('data-session-id')!)
  )
}

/**
 * Click "+ new" and return the ID of the newly created session.
 * Waits until the new session div appears in the sidebar.
 */
export async function newSession(page: Page): Promise<string> {
  const before = new Set(await getSessions(page))
  await page.click('.new-btn')
  // Wait for a new data-session-id to appear
  const id = await page.waitForFunction((prev: string[]) => {
    const current = [...document.querySelectorAll('[data-session-id]')]
      .map(el => el.getAttribute('data-session-id')!)
    return current.find(id => !prev.includes(id)) ?? null
  }, [...before], { timeout: 8000 })
  return id.jsonValue() as Promise<string>
}

/**
 * Read the full visible text content of a session's xterm.js terminal
 * via the buffer API exposed on window.__wt_terminals in dev mode.
 */
export async function getTerminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wt = (window as any).__wt_terminals
    if (!wt) return ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entry = wt.get(id) as any
    if (!entry) {
      for (const key of wt.keys() as Iterable<string>) {
        if (typeof key === 'string' && key.endsWith(`:${id}`)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          entry = wt.get(key) as any
          break
        }
      }
    }
    if (!entry) return ''
    const buf = entry.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n').trimEnd()
  }, sessionId)
}

/**
 * Wait until the terminal shows any non-whitespace content, indicating the
 * shell has started and printed its first prompt.
 *
 * Use this instead of waitForTerminal(page, id, 'somePromptString') when you
 * just need to know the session is ready for input. It works regardless of
 * shell type (bash/zsh), user (root/non-root), CWD, or custom prompt config —
 * the only requirement is that the shell outputs something on startup.
 */
export async function waitForPrompt(page: Page, sessionId: string, timeout = 8000): Promise<void> {
  await page.waitForFunction(
    (id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wt = (window as any).__wt_terminals
      if (!wt) return false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let entry = wt.get(id) as any
      if (!entry) {
        for (const key of wt.keys() as Iterable<string>) {
          if (typeof key === 'string' && key.endsWith(`:${id}`)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            entry = wt.get(key) as any
            break
          }
        }
      }
      if (!entry) return false
      const buf = entry.term.buffer.active
      for (let i = 0; i < buf.length; i++) {
        if (buf.getLine(i)?.translateToString(true)?.trim()) return true
      }
      return false
    },
    sessionId,
    { timeout },
  ).catch(async (err: Error) => {
    // Diagnose why waitForPrompt failed — log terminal state at time of failure
    const diag = await page.evaluate((id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wt = (window as any).__wt_terminals
      if (!wt) return 'no __wt_terminals map'
      const entry = wt.get(id)
      if (!entry) return `no entry for id ${id} (map has ${wt.size} entries, keys: ${[...wt.keys()].join(',')})`
      const buf = entry.term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < Math.min(buf.length, 5); i++) {
        lines.push(JSON.stringify(buf.getLine(i)?.translateToString(true) ?? ''))
      }
      return `entry exists (opened=${entry.opened}), buf.length=${buf.length}, first 5 lines: [${lines.join(', ')}]`
    }, sessionId)
    const sessions = await page.evaluate(() =>
      [...document.querySelectorAll('[data-session-id]')].map(el => el.getAttribute('data-session-id')).join(',')
    )
    throw new Error(`${err.message}\nDiagnostic: ${diag}\nVisible sessions: [${sessions}]`)
  })
}

/**
 * Poll the terminal buffer until `needle` appears, or throw on timeout.
 * Uses waitForFunction (no arbitrary sleeps) so it's as fast as possible.
 */
export async function waitForTerminal(
  page: Page,
  sessionId: string,
  needle: string,
  timeout = 8000,
): Promise<void> {
  await page.waitForFunction(
    ([id, text]: [string, string]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wt = (window as any).__wt_terminals
      if (!wt) return false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let entry = wt.get(id) as any
      if (!entry) {
        for (const key of wt.keys() as Iterable<string>) {
          if (typeof key === 'string' && key.endsWith(`:${id}`)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            entry = wt.get(key) as any
            break
          }
        }
      }
      if (!entry) return false
      const buf = entry.term.buffer.active
      let content = ''
      for (let i = 0; i < buf.length; i++) {
        content += (buf.getLine(i)?.translateToString(true) ?? '')
      }
      return content.includes(text)
    },
    [sessionId, needle] as [string, string],
    { timeout },
  )
}

/** Switch to a session by clicking its sidebar item. */
export async function switchToSession(page: Page, sessionId: string): Promise<void> {
  await page.click(`[data-session-id="${sessionId}"]`)
  // Wait for the WS attach to complete (ready acknowledged), not just the
  // optimistic active class switch in the sidebar.
  await page.waitForFunction(
    (id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getAttached = (window as any).__wt_get_attached_id
      if (typeof getAttached === 'function') return getAttached() === id
      return document.querySelector('.session-item.active')?.getAttribute('data-session-id') === id
    },
    sessionId,
    { timeout: 5000 },
  )
}

/**
 * Kill all sessions via direct WS messages (fast, no UI interaction).
 * Requires window.__wt_send to be exposed (dev mode only).
 *
 * Waits for WS connection AND for the initial sessions list to settle before
 * checking what to kill. Without this, getSessions() returns [] before the
 * WS delivers the sessions list, causing stale sessions to accumulate across
 * tests and confusing newSession()'s new-ID detection.
 */
export async function killAllSessions(page: Page): Promise<void> {
  // Wait for WS to connect AND for the sessions list to settle. We poll until
  // .status-dot.connected is present AND two consecutive polls see the same
  // session count (confirms the server's 'sessions' response has been rendered).
  await page.waitForFunction(
    () => {
      if (!document.querySelector('.status-dot.connected')) return false
      const count = document.querySelectorAll('[data-session-id]').length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prev = (window as any).__wt_kill_prev
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__wt_kill_prev = count
      return prev !== undefined && prev === count
    },
    { timeout: 8000 },
  )

  const ids = await getSessions(page)
  if (ids.length === 0) return

  // Kill sessions sequentially: kill one, wait for it to disappear, repeat.
  for (const id of ids) {
    await page.evaluate((id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = (window as any).__wt_send
      if (!send) throw new Error('__wt_send not available — is the app in dev mode?')
      send({ type: 'kill', id })
    }, id)
    await page.waitForFunction(
      (killId: string) => !document.querySelector(`[data-session-id="${killId}"]`),
      id,
      { timeout: 5000 },
    )
  }
}
