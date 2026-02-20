import { test, expect } from '@playwright/test'
import { getSessions, newSession, getTerminalText, waitForTerminal, switchToSession, killAllSessions } from './helpers'

/** Returns the data-session-id of the currently active session item. */
async function getActiveSessionId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() =>
    document.querySelector('.session-item.active')?.getAttribute('data-session-id') ?? null
  )
}

/** Returns the decoded URL hash without the leading '#'. */
async function getHash(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => decodeURIComponent(location.hash.slice(1)))
}

/** Returns the visible name text for a session item. */
async function getSessionName(page: import('@playwright/test').Page, id: string): Promise<string> {
  return page.$eval(`[data-session-id="${id}"] .session-name`, el => el.textContent ?? '')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Clean slate: kill any sessions left over from previous test runs
  await killAllSessions(page)
})

test('create session — appears in sidebar and shows shell prompt', async ({ page }) => {
  const id = await newSession(page)
  expect(id).toBeTruthy()
  // Shell prompt should appear (zsh/bash both show %)
  await waitForTerminal(page, id, 'workspace')
})

test('switch sessions — scrollback not duplicated on return', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForTerminal(page, id1, 'workspace')

  // Type a unique marker in session 1
  const marker = `wt_test_${Date.now()}`
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await waitForTerminal(page, id1, marker)

  // Record the baseline count (marker appears in both the command line and output)
  const textBefore = await getTerminalText(page, id1)
  const countBefore = (textBefore.match(new RegExp(marker, 'g')) ?? []).length
  expect(countBefore).toBeGreaterThan(0)

  // Switch to session 2, then back to session 1
  const id2 = await newSession(page)
  await waitForTerminal(page, id2, 'workspace')
  await switchToSession(page, id1)
  await waitForTerminal(page, id1, marker) // wait for scrollback replay

  // Count must equal the baseline — if doubled, the regression is back
  const textAfter = await getTerminalText(page, id1)
  const countAfter = (textAfter.match(new RegExp(marker, 'g')) ?? []).length
  expect(countAfter).toBe(countBefore)
})

test('kill session — removed from sidebar', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  // Right-click → Kill → confirm
  await page.click(`[data-session-id="${id}"]`, { button: 'right' })
  await page.click('button:has-text("Kill")')
  await page.click('.modal-confirm')

  await expect(page.locator(`[data-session-id="${id}"]`)).toBeHidden({ timeout: 3000 })
})

test('rename session — name persisted in sidebar', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  const newName = `renamed-${Date.now()}`

  // Double-click the session name to enter rename mode
  await page.dblclick(`[data-session-id="${id}"] .session-name`)
  await page.fill('.session-name-input', newName)
  await page.keyboard.press('Enter')

  // Name should update in sidebar
  await expect(page.locator(`[data-session-id="${id}"] .session-name`))
    .toHaveText(newName, { timeout: 3000 })
})

test('reconnect — session survives page reload, content preserved', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  const marker = `reconnect_${Date.now()}`
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await waitForTerminal(page, id, marker)
  const textBefore = await getTerminalText(page, id)
  const countBefore = (textBefore.match(new RegExp(marker, 'g')) ?? []).length

  // Reload the page (simulates tab close + reopen)
  await page.reload()

  // Wait for WS to reconnect and deliver the sessions list
  await page.waitForSelector('[data-session-id]', { timeout: 8000 })

  // Session should still be in the sidebar
  const sessions = await getSessions(page)
  expect(sessions).toContain(id)

  // Re-attach and verify content is there (not blank, not doubled).
  // We compare against countBefore since echo marker appears in both
  // the command line and output (so count > 1 is expected, not a bug).
  await switchToSession(page, id)
  await waitForTerminal(page, id, marker)

  const textAfter = await getTerminalText(page, id)
  const countAfter = (textAfter.match(new RegExp(marker, 'g')) ?? []).length
  expect(countAfter).toBe(countBefore)
})

test('terminal input produces output', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  await page.keyboard.type('echo "wt_output_test"')
  await page.keyboard.press('Enter')
  await waitForTerminal(page, id, 'wt_output_test')

  const text = await getTerminalText(page, id)
  expect(text).toContain('wt_output_test')
})

test('Alt+T creates a new session', async ({ page }) => {
  const before = await getSessions(page)
  await page.keyboard.press('Alt+t')
  await page.waitForFunction(
    (count: number) => document.querySelectorAll('[data-session-id]').length > count,
    before.length,
    { timeout: 5000 },
  )
  const after = await getSessions(page)
  expect(after.length).toBe(before.length + 1)
})

test('Alt+1 switches to first session', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForTerminal(page, id1, 'workspace')
  const id2 = await newSession(page)
  await waitForTerminal(page, id2, 'workspace')

  // id2 should be active after creation
  expect(await getActiveSessionId(page)).toBe(id2)

  // The handler now checks e.code (physical key) not e.key, so we dispatch
  // with code: 'Digit1'. page.keyboard.press('Alt+1') would also work here
  // since Playwright sends the correct code regardless of OS key remapping.
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Digit1', altKey: true, bubbles: true, cancelable: true })
    )
  })

  // attachSession sets currentId optimistically — the active class switches
  // before the server responds, so we can assert DOM state directly.
  await page.waitForFunction(
    (id: string) =>
      document.querySelector('.session-item.active')?.getAttribute('data-session-id') === id,
    id1,
    { timeout: 3000 },
  )
})

test('session order persists across page reload', async ({ page }) => {
  const id1 = await newSession(page)
  const id2 = await newSession(page)
  const id3 = await newSession(page)
  // No need to wait for terminal content — just need all 3 in sidebar
  await page.waitForFunction(
    () => document.querySelectorAll('[data-session-id]').length >= 3,
    { timeout: 5000 },
  )

  const orderBefore = await getSessions(page)
  expect(orderBefore).toContain(id1)

  await page.reload()
  await page.waitForSelector('[data-session-id]', { timeout: 8000 })

  const orderAfter = await getSessions(page)
  // All sessions still present in the same order
  expect(orderAfter).toEqual(orderBefore)
})

test('duplicate session — spawns in same CWD, appears after source', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForTerminal(page, id1, 'workspace')

  const before = await getSessions(page)

  // Right-click → Duplicate
  await page.click(`[data-session-id="${id1}"]`, { button: 'right' })
  await page.click('button:has-text("Duplicate")')

  // A new session should appear
  const after = await page.waitForFunction((prev: string[]) => {
    const current = [...document.querySelectorAll('[data-session-id]')]
      .map(el => el.getAttribute('data-session-id')!)
    return current.length > prev.length ? current : null
  }, before, { timeout: 5000 })

  const afterIds = await after.jsonValue() as string[]
  const newId = afterIds.find(id => !before.includes(id))!
  expect(newId).toBeTruthy()

  // New session should be directly after the source in the list
  const srcIdx = afterIds.indexOf(id1)
  const newIdx = afterIds.indexOf(newId)
  expect(newIdx).toBe(srcIdx + 1)
})

test('kill session — cancel in modal keeps session alive', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  // Open kill modal via right-click
  await page.click(`[data-session-id="${id}"]`, { button: 'right' })
  await page.click('button:has-text("Kill")')
  await expect(page.locator('.modal')).toBeVisible()

  // Cancel — session must survive
  await page.click('.modal-cancel')
  await expect(page.locator(`[data-session-id="${id}"]`)).toBeVisible({ timeout: 2000 })

  // Escape key is another cancel path — reopen and escape
  await page.click(`[data-session-id="${id}"]`, { button: 'right' })
  await page.click('button:has-text("Kill")')
  await expect(page.locator('.modal')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(`[data-session-id="${id}"]`)).toBeVisible({ timeout: 2000 })
})

test('Alt+W — opens kill modal for active session', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  await page.keyboard.press('Alt+w')

  // Modal should appear targeting this session
  await expect(page.locator('.modal')).toBeVisible({ timeout: 2000 })

  // Confirm the kill
  await page.click('.modal-confirm')
  await expect(page.locator(`[data-session-id="${id}"]`)).toBeHidden({ timeout: 3000 })
})

test('rename — Escape reverts to original name', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  const originalName = await page.locator(`[data-session-id="${id}"] .session-name`).textContent()

  // Enter edit mode and type a different name
  await page.dblclick(`[data-session-id="${id}"] .session-name`)
  await page.fill('.session-name-input', 'should-not-persist')

  // Escape should cancel without renaming
  await page.keyboard.press('Escape')

  await expect(page.locator(`[data-session-id="${id}"] .session-name`))
    .toHaveText(originalName!, { timeout: 2000 })
})

test('WS reconnect — session survives network drop', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  // Confirm connected before going offline
  await expect(page.locator('.status-dot.connected')).toBeVisible()

  // Drop the network — WS closes, app switches to reconnecting state.
  // setOffline lives on BrowserContext, not Page.
  await page.context().setOffline(true)
  await expect(page.locator('.status-dot.reconnecting')).toBeVisible({ timeout: 5000 })

  // Restore network — useWS retries every 1500ms, so allow up to 8s
  await page.context().setOffline(false)
  await expect(page.locator('.status-dot.connected')).toBeVisible({ timeout: 8000 })

  // Session still in sidebar and terminal content replayed from server buffer
  await expect(page.locator(`[data-session-id="${id}"]`)).toBeVisible()
  await waitForTerminal(page, id, 'workspace')
})

test('url hash — switching session updates hash to session name', async ({ page }) => {
  const id1 = await newSession(page)
  const id2 = await newSession(page)
  // id2 is active after creation; switch to id1
  await switchToSession(page, id1)
  const name1 = await getSessionName(page, id1)

  await page.waitForFunction(
    (name: string) => decodeURIComponent(location.hash.slice(1)) === name,
    name1,
    { timeout: 3000 },
  )
  expect(await getHash(page)).toBe(name1)

  // Switch back to id2 — hash should follow
  await switchToSession(page, id2)
  const name2 = await getSessionName(page, id2)
  await page.waitForFunction(
    (name: string) => decodeURIComponent(location.hash.slice(1)) === name,
    name2,
    { timeout: 3000 },
  )
  expect(await getHash(page)).toBe(name2)
})

test('url hash — loading /#name attaches to correct session', async ({ page }) => {
  const id = await newSession(page)
  const name = await getSessionName(page, id)

  // Reload with the hash — simulates opening a bookmark
  await page.goto(`/#${encodeURIComponent(name)}`)
  await page.waitForSelector('[data-session-id]', { timeout: 8000 })

  await page.waitForFunction(
    (expectedName: string) =>
      document.querySelector('.session-item.active .session-name')?.textContent === expectedName,
    name,
    { timeout: 5000 },
  )
  expect(await getActiveSessionId(page)).toBe(id)
})

test('url hash — killing current session clears or updates hash', async ({ page }) => {
  const id1 = await newSession(page)
  const id2 = await newSession(page)
  await page.waitForFunction(
    () => document.querySelectorAll('[data-session-id]').length >= 2,
    { timeout: 5000 },
  )

  // Switch to id1 so there is a replacement (id2)
  await switchToSession(page, id1)
  await page.waitForFunction(
    (id: string) => document.querySelector('.session-item.active')?.getAttribute('data-session-id') === id,
    id1,
    { timeout: 3000 },
  )

  // Kill id1 via right-click → Kill → confirm
  await page.click(`[data-session-id="${id1}"]`, { button: 'right' })
  await page.click('button:has-text("Kill")')
  await page.click('.modal-confirm')

  await expect(page.locator(`[data-session-id="${id1}"]`)).toBeHidden({ timeout: 3000 })

  // Hash should now reflect id2 (the replacement), not id1
  const name1 = await getSessionName(page, id1).catch(() => '')
  const hash = await getHash(page)
  expect(hash).not.toBe(name1)
  // And id2 should be active
  expect(await getActiveSessionId(page)).toBe(id2)
})

test('no hash on load — auto-attaches to first session', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, 'workspace')

  // Navigate to base URL (no hash)
  await page.goto('/')
  await page.waitForSelector('.session-item.active', { timeout: 8000 })

  // Should auto-attach to the only existing session
  expect(await getActiveSessionId(page)).toBe(id)
})
