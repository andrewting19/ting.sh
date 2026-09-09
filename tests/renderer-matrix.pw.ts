import { test, expect } from '@playwright/test'
import { getActiveRenderer, getTerminalText, killAllSessions, loadWithRenderer, newSession, switchToSession, waitForPrompt, waitForTerminal } from './helpers'
import type { TerminalRenderer } from '../src/terminal/backends'

const CORE_RENDERERS: TerminalRenderer[] = ['xterm', 'ghostty']

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

    test('Shift+Enter inserts a bracketed newline without submitting Enter', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)
      await page.keyboard.type(`python3 -u '${process.cwd()}/tests/fixtures/modified-enter.py' --paste`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, 'KEY_PROBE_READY', 5000)

      // A non-terminal text input must retain native multiline behavior and
      // must not send its Shift+Enter to the active PTY.
      await page.evaluate(() => {
        const textarea = document.createElement('textarea')
        textarea.id = 'modified-enter-outside-terminal'
        document.body.append(textarea)
        textarea.focus()
      })
      await page.keyboard.press('Shift+Enter')
      await expect(page.locator('#modified-enter-outside-terminal')).toHaveValue('\n')
      await page.evaluate(() => document.getElementById('modified-enter-outside-terminal')?.remove())
      await switchToSession(page, id)

      await page.keyboard.press('Shift+Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Alt+Enter')
      await page.keyboard.type('Z')
      await waitForTerminal(page, id, 'KEY_PROBE_HEX=', 5000)
      // One pasted newline, then unchanged plain Enter and legacy Alt+Enter.
      expect(await getTerminalText(page, id)).toContain('KEY_PROBE_HEX=1b5b3230307e0a1b5b3230317e0d1b0d')
    })

    test('Shift+Enter does not inject codes or submit when safe paste is disabled', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)
      await page.keyboard.type(`python3 -u '${process.cwd()}/tests/fixtures/modified-enter.py'`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, 'KEY_PROBE_READY', 5000)
      await page.keyboard.press('Shift+Enter')
      await expect(page.getByRole('status')).toContainText('Shift+Enter sent no input')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Alt+Enter')
      await page.keyboard.type('Z')
      await waitForTerminal(page, id, 'KEY_PROBE_HEX=0d1b0d', 5000)
    })

    test('Shift+Enter keeps safe paste after session switch and reload', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)
      await page.keyboard.type(`python3 -u '${process.cwd()}/tests/fixtures/modified-enter.py' --paste`)
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, 'KEY_PROBE_READY', 5000)
      const otherId = await newSession(page)
      await waitForPrompt(page, otherId, 12000)
      await switchToSession(page, id)
      await page.reload()
      await page.waitForSelector(`[data-session-id="${id}"]`)
      await switchToSession(page, id)
      await waitForTerminal(page, id, 'KEY_PROBE_READY', 5000)
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('Z')
      await waitForTerminal(page, id, 'KEY_PROBE_HEX=1b5b3230307e0a1b5b3230317e', 5000)
      // Fixture exits and disables paste; no stale mode may leak to the shell.
      await page.keyboard.press('Shift+Enter')
      await expect(page.getByRole('status')).toContainText('Shift+Enter sent no input')
    })

    test('Shift+Enter inserts a real newline in zsh without running commands', async ({ page }) => {
      const id = await newSession(page)
      await waitForPrompt(page, id, 12000)
      await page.keyboard.type("/bin/zsh -f")
      await page.keyboard.press('Enter')
      await page.keyboard.type("PS1='ZSH_READY> '; PS2='more> '; bindkey -e")
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, 'ZSH_READY>', 5000)
      await page.keyboard.type("printf 'RUN_%s\\n' after_enter")
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type("printf 'NEXT_%s\\n' after_enter")
      const pending = await getTerminalText(page, id)
      expect(pending).not.toContain('RUN_after_enter')
      expect(pending).not.toContain('NEXT_after_enter')
      expect(pending).not.toContain('[13;2u')
      await page.keyboard.press('Enter')
      await waitForTerminal(page, id, 'RUN_after_enter', 5000)
      await waitForTerminal(page, id, 'NEXT_after_enter', 5000)
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
