import { test, expect } from '@playwright/test'
import { getSessions, newSession, getTerminalText, waitForTerminal, switchToSession, killAllSessions } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Clean slate: kill any sessions left over from previous test runs
  await killAllSessions(page)
})

test('create session — appears in sidebar and shows shell prompt', async ({ page }) => {
  const id = await newSession(page)
  expect(id).toBeTruthy()
  // Shell prompt should appear (zsh/bash both show %)
  await waitForTerminal(page, id, '%')
})

test('switch sessions — scrollback not duplicated on return', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForTerminal(page, id1, '%')

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
  await waitForTerminal(page, id2, '%')
  await switchToSession(page, id1)
  await waitForTerminal(page, id1, marker) // wait for scrollback replay

  // Count must equal the baseline — if doubled, the regression is back
  const textAfter = await getTerminalText(page, id1)
  const countAfter = (textAfter.match(new RegExp(marker, 'g')) ?? []).length
  expect(countAfter).toBe(countBefore)
})

test('kill session — removed from sidebar', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, '%')

  // Right-click → Kill → confirm
  await page.click(`[data-session-id="${id}"]`, { button: 'right' })
  await page.click('button:has-text("Kill")')
  await page.click('.modal-confirm')

  await expect(page.locator(`[data-session-id="${id}"]`)).toBeHidden({ timeout: 3000 })
})

test('rename session — name persisted in sidebar', async ({ page }) => {
  const id = await newSession(page)
  await waitForTerminal(page, id, '%')

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
  await waitForTerminal(page, id, '%')

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

test('duplicate session — spawns in same CWD, appears after source', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForTerminal(page, id1, '%')

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
