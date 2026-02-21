import { test, expect } from '@playwright/test'
import { getSessions, newSession, getTerminalText, waitForTerminal, waitForPrompt, switchToSession, killAllSessions } from './helpers'

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

/** Read the PTY rows/cols by running `stty size` and parsing marked output. */
async function getSttySize(page: import('@playwright/test').Page, id: string): Promise<{ rows: number; cols: number }> {
  const marker = `__WT_SIZE_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}__`
  await page.keyboard.type(`printf '${marker} '; stty size`)
  await page.keyboard.press('Enter')
  await waitForTerminal(page, id, marker)

  const result = await page.waitForFunction(
    ([sessionId, outputMarker]: [string, string]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wt = (window as any).__wt_terminals
      if (!wt) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let entry = wt.get(sessionId) as any
      if (!entry) {
        for (const key of wt.keys() as Iterable<string>) {
          if (typeof key === 'string' && key.endsWith(`:${sessionId}`)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            entry = wt.get(key) as any
            break
          }
        }
      }
      if (!entry) return null
      const buf = entry.term.buffer.active
      let found: { rows: number; cols: number } | null = null
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)?.translateToString(true) ?? ''
        const idx = line.indexOf(outputMarker)
        if (idx === -1) continue
        const m = line.slice(idx + outputMarker.length).trim().match(/^(\d+)\s+(\d+)/)
        if (m) found = { rows: Number(m[1]), cols: Number(m[2]) }
      }
      return found
    },
    [id, marker] as [string, string],
    { timeout: 5000 },
  )

  return result.jsonValue() as Promise<{ rows: number; cols: number }>
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Clean slate: atomic kill-all avoids auto-attach cascade
  await killAllSessions(page)
})

test('create session — appears in sidebar and shows shell prompt', async ({ page }) => {
  const id = await newSession(page)
  expect(id).toBeTruthy()
  // Shell prompt should appear (zsh/bash both show %)
  await waitForPrompt(page, id)
})

test('switch sessions — scrollback not duplicated on return', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForPrompt(page, id1)

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
  await waitForPrompt(page, id2)
  await switchToSession(page, id1)
  await waitForTerminal(page, id1, marker) // wait for scrollback replay

  // Count must equal the baseline — if doubled, the regression is back
  const textAfter = await getTerminalText(page, id1)
  const countAfter = (textAfter.match(new RegExp(marker, 'g')) ?? []).length
  expect(countAfter).toBe(countBefore)
})

test('switch during noisy output — old session bytes do not leak', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForPrompt(page, id1)
  const id2 = await newSession(page)
  await waitForPrompt(page, id2)

  await switchToSession(page, id1)
  await waitForPrompt(page, id1)

  const marker = `LEAK_${Date.now()}`
  await page.keyboard.type(`for i in {1..50000}; do echo ${marker}; done`)
  await page.keyboard.press('Enter')
  await waitForTerminal(page, id1, marker)

  await switchToSession(page, id2)
  await waitForPrompt(page, id2)

  const text2 = await getTerminalText(page, id2)
  expect(text2.includes(marker), `marker leaked into session2: ${marker}`).toBe(false)
})

test('rapid multi-switch keeps final session clean', async ({ page }) => {
  const id1 = await newSession(page)
  await waitForPrompt(page, id1)
  const id2 = await newSession(page)
  await waitForPrompt(page, id2)
  const id3 = await newSession(page)
  await waitForPrompt(page, id3)

  await switchToSession(page, id2)
  const marker2 = `M2_${Date.now()}`
  await page.keyboard.type(`echo ${marker2}`)
  await page.keyboard.press('Enter')
  await waitForTerminal(page, id2, marker2)

  await switchToSession(page, id3)
  const marker3 = `M3_${Date.now()}`
  await page.keyboard.type(`echo ${marker3}`)
  await page.keyboard.press('Enter')
  await waitForTerminal(page, id3, marker3)

  await page.evaluate(([a, b]) => {
    const first = document.querySelector<HTMLElement>(`[data-session-id="${a}"]`)
    const second = document.querySelector<HTMLElement>(`[data-session-id="${b}"]`)
    first?.click()
    second?.click()
  }, [id2, id3])

  await page.waitForFunction(
    (id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getAttached = (window as any).__wt_get_attached_id
      return typeof getAttached === 'function' && getAttached() === id
    },
    id3,
    { timeout: 5000 },
  )
  await waitForPrompt(page, id3)

  const text3 = await getTerminalText(page, id3)
  expect(text3.includes(marker2), `id2 marker leaked into id3: ${marker2}`).toBe(false)
  expect(text3).toContain(marker3)
})

test('kill session — removed from sidebar', async ({ page }) => {
  const id = await newSession(page)
  await waitForPrompt(page, id)

  // Right-click → Kill → confirm
  await page.click(`[data-session-id="${id}"]`, { button: 'right' })
  await page.click('button:has-text("Kill")')
  await page.click('.modal-confirm')

  await expect(page.locator(`[data-session-id="${id}"]`)).toBeHidden({ timeout: 3000 })
})

test('rename session — name persisted in sidebar', async ({ page }) => {
  const id = await newSession(page)
  await waitForPrompt(page, id)

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
  await waitForPrompt(page, id)

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
  await waitForPrompt(page, id)

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
  await waitForPrompt(page, id1)
  const id2 = await newSession(page)
  await waitForPrompt(page, id2)

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
  await waitForPrompt(page, id1)

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
  await waitForPrompt(page, id)

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
  await waitForPrompt(page, id)

  await page.keyboard.press('Alt+w')

  // Modal should appear targeting this session
  await expect(page.locator('.modal')).toBeVisible({ timeout: 2000 })

  // Confirm the kill
  await page.click('.modal-confirm')
  await expect(page.locator(`[data-session-id="${id}"]`)).toBeHidden({ timeout: 3000 })
})

test('rename — Escape reverts to original name', async ({ page }) => {
  const id = await newSession(page)
  await waitForPrompt(page, id)

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
  await waitForPrompt(page, id)

  // Confirm connected before dropping
  await expect(page.locator('.status-dot.connected')).toBeVisible()

  // Close the WebSocket from the client side — setOffline doesn't reliably
  // affect localhost connections in all browsers/Playwright versions.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__wt_ws_close?.()
  })
  await expect(page.locator('.status-dot.reconnecting')).toBeVisible({ timeout: 5000 })

  // useWS retries every 1500ms, so allow up to 8s for reconnect
  await expect(page.locator('.status-dot.connected')).toBeVisible({ timeout: 8000 })

  // Session still in sidebar and terminal content replayed from server buffer
  await expect(page.locator(`[data-session-id="${id}"]`)).toBeVisible()
  await waitForPrompt(page, id)
})

test('shared session — desktop reclaims width after mobile resize', async ({ page, browser }) => {
  const id = await newSession(page)
  await waitForPrompt(page, id)

  const desktopBefore = await getSttySize(page, id)

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobile = await mobileContext.newPage()
  try {
    await mobile.goto('/')
    await mobile.waitForSelector(`[data-session-id="${id}"]`, { timeout: 8000 })
    await mobile.waitForFunction(
      (sessionId: string) =>
        document.querySelector('.session-item.active')?.getAttribute('data-session-id') === sessionId,
      id,
      { timeout: 5000 },
    )
    await waitForPrompt(mobile, id)

    const mobileSize = await getSttySize(mobile, id)
    expect(mobileSize.cols).toBeLessThan(desktopBefore.cols)

    // Simulate returning to desktop and re-selecting the same session.
    await page.bringToFront()
    await page.click(`[data-session-id="${id}"]`)
    const desktopAfter = await getSttySize(page, id)
    expect(desktopAfter.cols).toBeGreaterThan(mobileSize.cols)
  } finally {
    await mobileContext.close()
  }
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

  // Navigate to base URL (no hash) — forces a fresh page load
  await page.goto('/')
  await page.waitForSelector('.session-item.active', { timeout: 8000 })

  // Should auto-attach to the only existing session
  expect(await getActiveSessionId(page)).toBe(id)
})
