import { test, expect } from '@playwright/test'
import { getActiveRenderer, getTerminalText, killAllSessions, loadWithRenderer, newSession, switchToSession, waitForPrompt, waitForTerminal } from './helpers'
import type { TerminalRenderer } from '../src/terminal/backends'

const CORE_RENDERERS: TerminalRenderer[] = ['xterm', 'ghostty']
const CLAUDE_COMPAT_STORAGE_KEY = 'wt-claude-code-compat'

for (const renderer of CORE_RENDERERS) {
  test.describe(`${renderer} renderer core flows`, () => {
    test.beforeEach(async ({ page }) => {
      await loadWithRenderer(page, renderer)
      expect(await getActiveRenderer(page)).toBe(renderer)
    })

    test('create session and show shell prompt', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)
    })

    test('terminal input produces output', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)

      await page.keyboard.type(`echo "${renderer}_matrix_output"`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, `${renderer}_matrix_output`, 12000)

      const text = await getTerminalText(page, id)
      expect(text).toContain(`${renderer}_matrix_output`)
    })

    test('Claude Code compat header toggle persists and terminal stays responsive', async ({ page }) => {
      const compatToggle = page.getByRole('button', { name: 'Toggle Claude Code resize compatibility mode' })
      await expect(compatToggle).toHaveAttribute('aria-pressed', 'false')

      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        compatToggle.click(),
      ])

      await page.waitForFunction(
        (expectedRenderer: TerminalRenderer) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const debug = (window as any).__wt_terminal_debug
          const value = debug?.getRenderer?.() ?? document.documentElement.dataset.terminalRenderer
          return value === expectedRenderer
        },
        renderer,
        { timeout: 12000 },
      )

      expect(await getActiveRenderer(page)).toBe(renderer)
      await expect(compatToggle).toHaveAttribute('aria-pressed', 'true')

      const compatValue = await page.evaluate((storageKey: string) => localStorage.getItem(storageKey), CLAUDE_COMPAT_STORAGE_KEY)
      expect(compatValue).toBe('1')

      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)

      await page.keyboard.type(`echo "${renderer}_compat_toggle_output"`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, `${renderer}_compat_toggle_output`, 12000)

      const text = await getTerminalText(page, id)
      expect(text).toContain(`${renderer}_compat_toggle_output`)
    })

    test('switch sessions without duplicating scrollback', async ({ page }) => {
      const id1 = await newSession(page)
      await waitForPrompt(page, id1, 12000)

      const marker = `${renderer}_switch_${Date.now()}`
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id1, marker, 12000)
      const textBefore = await getTerminalText(page, id1)
      const countBefore = (textBefore.match(new RegExp(marker, 'g')) ?? []).length

      const id2 = await newSession(page)
      await waitForPrompt(page, id2, 12000)
      await switchToSession(page, id1)
      await waitForTerminal(page, id1, marker, 12000)

      const textAfter = await getTerminalText(page, id1)
      const countAfter = (textAfter.match(new RegExp(marker, 'g')) ?? []).length
      expect(countAfter).toBe(countBefore)
    })

    test('session switch does not inject focus-report escape sequences', async ({ page }) => {
      const id1 = await newSession(page)
      await waitForPrompt(page, id1, 12000)
      const id2 = await newSession(page)
      await waitForPrompt(page, id2, 12000)

      await switchToSession(page, id1)
      await waitForPrompt(page, id1, 12000)

      await page.keyboard.type("printf '\\e[?1004h'")
      await page.keyboard.press('Enter')
      await waitForPrompt(page, id1, 12000)

      await switchToSession(page, id2)
      await waitForPrompt(page, id2, 12000)
      await switchToSession(page, id1)
      await waitForPrompt(page, id1, 12000)

      const text = await getTerminalText(page, id1)
      expect(text).not.toContain('^[[I')
      expect(text).not.toContain('^[[O')
    })

    test('reload preserves session content', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)

      const marker = `${renderer}_reload_${Date.now()}`
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, marker, 12000)
      const textBefore = await getTerminalText(page, id)
      const countBefore = (textBefore.match(new RegExp(marker, 'g')) ?? []).length

      await page.reload()
      await page.waitForSelector('[data-session-id]', { timeout: 12000 })
      expect(await getActiveRenderer(page)).toBe(renderer)
      await switchToSession(page, id)
      await waitForTerminal(page, id, marker, 12000)

      const textAfter = await getTerminalText(page, id)
      const countAfter = (textAfter.match(new RegExp(marker, 'g')) ?? []).length
      expect(countAfter).toBe(countBefore)
    })

    test('force-closed websocket reconnect preserves session content', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)

      const marker = `${renderer}_reconnect_${Date.now()}`
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, marker, 12000)

      await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).__wt_ws_close?.()
      })
      await expect(page.locator('.status-dot.reconnecting').first()).toBeVisible({ timeout: 5000 })
      await expect(page.locator('.status-dot.connected').first()).toBeVisible({ timeout: 8000 })

      await switchToSession(page, id)
      await waitForTerminal(page, id, marker, 12000)
      const text = await getTerminalText(page, id)
      expect(text).toContain(marker)
    })

    test('noisy output from the old session does not leak after a switch', async ({ page }) => {
      const id1 = await newSession(page)
      await waitForPrompt(page, id1, 12000)
      const id2 = await newSession(page)
      await waitForPrompt(page, id2, 12000)

      await switchToSession(page, id1)
      await waitForPrompt(page, id1, 12000)

      const marker = `${renderer}_leak_${Date.now()}`
      await page.keyboard.type(`for i in {1..5000}; do echo ${marker}; done`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id1, marker, 12000)

      await switchToSession(page, id2)
      await waitForPrompt(page, id2, 12000)

      const text = await getTerminalText(page, id2)
      expect(text.includes(marker)).toBe(false)
    })
  })
}
