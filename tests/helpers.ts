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
    const entry = (window as any).__wt_terminals?.get(id)
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
      const entry = (window as any).__wt_terminals?.get(id)
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
}

/**
 * Kill all sessions via direct WS messages (fast, no UI interaction).
 * Requires window.__wt_send to be exposed (dev mode only).
 */
export async function killAllSessions(page: Page): Promise<void> {
  const ids = await getSessions(page)
  if (ids.length === 0) return

  await page.evaluate((ids: string[]) => {
    const send = (window as any).__wt_send
    if (!send) throw new Error('__wt_send not available — is the app in dev mode?')
    for (const id of ids) send({ type: 'kill', id })
  }, ids)

  // Wait for all session items to vanish from the DOM
  await page.waitForFunction(
    () => document.querySelectorAll('[data-session-id]').length === 0,
    { timeout: 5000 },
  )
}
