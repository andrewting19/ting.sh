/**
 * Mobile touch-scroll tests — run with iPhone user agent so mobile touch handlers activate.
 *
 * These tests dispatch raw TouchEvent sequences and verify the xterm buffer
 * viewportY changes.  They run on Chromium (not iOS Safari), so they CANNOT
 * reproduce iOS UIKit's gesture-recognizer behaviour (where touchmove is
 * suppressed while UIKit decides text-selection vs scroll).  What they DO catch:
 *   - The core JS scroll path works: touchmove fires → term.scrollLines()
 *   - preventDefault on touchmove (active listener) doesn't break scrolling
 *   - Our momentum rAF loop runs without errors
 *   - Regressions in mobile touch-listener setup / teardown
 *
 * Physical iOS Safari still needs device verification for true gesture behavior;
 * these tests guard our JS path plus renderer configuration.
 */

import { test, expect } from '@playwright/test'
import { waitForPrompt, loadWithRenderer, switchToSession } from './helpers'
import type { Page } from '@playwright/test'
import type { TerminalRenderer } from '../src/terminal/backends'

// Spoof iPhone UA so iOS-specific terminal behavior is active.
test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})

async function loadMobileRenderer(page: Page, renderer: TerminalRenderer = 'xterm'): Promise<void> {
  await loadWithRenderer(page, renderer)
}

/** Create a session via WS (bypasses the sidebar which is hidden on mobile). */
async function newSessionMobile(page: Page): Promise<string> {
  return page.evaluate(() => {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('newSessionMobile: timed out')), 8000)
      const before = new Set(
        [...document.querySelectorAll('[data-session-id]')].map(
          el => el.getAttribute('data-session-id')!,
        ),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__wt_send({ type: 'create', cols: 80, rows: 24 })
      const observer = new MutationObserver(() => {
        const current = [...document.querySelectorAll('[data-session-id]')].map(
          el => el.getAttribute('data-session-id')!,
        )
        const newId = current.find(id => !before.has(id))
        if (newId) {
          clearTimeout(timeout)
          observer.disconnect()
          resolve(newId)
        }
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    })
  })
}

/**
 * Dispatch a vertical touch swipe inside the active terminal pane.
 * startY > endY  → finger moves up   → content scrolls down  → viewportY increases
 * startY < endY  → finger moves down → content scrolls up    → viewportY decreases
 *
 * Returns viewportY (xterm buffer scroll position) before and after the swipe.
 */
async function touchSwipe(
  page: Page,
  opts: { startY: number; endY: number; steps?: number },
): Promise<{ viewportYBefore: number; viewportYAfter: number }> {
  const { startY, endY, steps = 10 } = opts

  return page.evaluate(
    ({ startY, endY, steps }) => {
      const container = document.querySelector<HTMLElement>('.terminal-pane.active')
      if (!container) throw new Error('no active .terminal-pane')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debug = (window as any).__wt_terminal_debug
      if (!debug?.getState) throw new Error('no __wt_terminal_debug')
      const activeId = (window as any).__wt_get_attached_id?.()
      if (!activeId) throw new Error('no active terminal id')

      const bounds = container.getBoundingClientRect()
      const clientX = bounds.left + bounds.width / 2
      const viewportYBefore = debug.getState(activeId)?.scroll?.offsetFromTop
      if (typeof viewportYBefore !== 'number') throw new Error('no viewportYBefore')

      // Dispatch on the container so capture-phase listeners (our iOS scroll
      // handler) receive the events.
      const fire = (type: string, y: number) => {
        const touch = new Touch({
          identifier: 1,
          target: container,
          clientX,
          clientY: y,
          screenX: clientX,
          screenY: y,
          pageX: clientX,
          pageY: y,
          radiusX: 10,
          radiusY: 10,
          rotationAngle: 0,
          force: 1,
        })
        container.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === 'touchend' ? [] : [touch],
            changedTouches: [touch],
          }),
        )
      }

      fire('touchstart', startY)
      const dy = (endY - startY) / steps
      for (let i = 1; i <= steps; i++) fire('touchmove', startY + dy * i)
      fire('touchend', endY)

      const viewportYAfter = debug.getState(activeId)?.scroll?.offsetFromTop
      if (typeof viewportYAfter !== 'number') throw new Error('no viewportYAfter')
      return { viewportYBefore, viewportYAfter }
    },
    { startY, endY, steps },
  )
}

test('iPhone UA uses DOM renderer (no WebGL canvas)', async ({ page }) => {
  await loadMobileRenderer(page, 'xterm')
  const id = await newSessionMobile(page)
  await waitForPrompt(page, id)

  // In xterm.js v6, iOS uses the built-in DOM renderer (WebGL is skipped on
  // mobile). The DOM renderer creates .xterm-rows with <div> row elements.
  await page.waitForFunction(() => {
    const pane = document.querySelector<HTMLElement>('.terminal-pane.active')
    if (!pane) return false
    return !!pane.querySelector('.xterm-rows')
  })

  const info = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('.terminal-pane.active')
    if (!pane) throw new Error('no active .terminal-pane')
    return {
      canvasCount: pane.querySelectorAll('.xterm-screen canvas').length,
      hasDomRows: !!pane.querySelector('.xterm-rows'),
    }
  })

  // No WebGL canvas on mobile; DOM renderer produces .xterm-rows
  expect(info.canvasCount).toBe(0)
  expect(info.hasDomRows).toBe(true)
})

async function fillTerminalWithScrollback(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__wt_send({ type: 'input', data: 'printf "%0.s\\n" {1..200}\r' })
  })
  await page.waitForTimeout(1500)
}

async function getActivePaneBounds(page: Page): Promise<{ top: number; height: number }> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.terminal-pane.active')
    if (!el) throw new Error('no active .terminal-pane')
    const r = el.getBoundingClientRect()
    return { top: r.top, height: r.height }
  })
}

for (const renderer of ['xterm', 'ghostty'] as const) {
  test(`${renderer}: touch swipe up scrolls terminal down (viewportY increases)`, async ({ page }) => {
    await loadMobileRenderer(page, renderer)
    const id = await newSessionMobile(page)
    await waitForPrompt(page, id)
    await fillTerminalWithScrollback(page)

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debug = (window as any).__wt_terminal_debug
      const activeId = (window as any).__wt_get_attached_id?.()
      if (debug?.scrollToTop && activeId) debug.scrollToTop(activeId)
    })
    await page.waitForTimeout(50)

    const bounds = await getActivePaneBounds(page)
    const { viewportYBefore, viewportYAfter } = await touchSwipe(page, {
      startY: bounds.top + bounds.height * 0.7,
      endY: bounds.top + bounds.height * 0.2,
    })

    expect(viewportYAfter, `viewportY should increase: before=${viewportYBefore} after=${viewportYAfter}`)
      .toBeGreaterThan(viewportYBefore)
  })

  test(`${renderer}: touch swipe down scrolls terminal up (viewportY decreases)`, async ({ page }) => {
    await loadMobileRenderer(page, renderer)
    const id = await newSessionMobile(page)
    await waitForPrompt(page, id)
    await fillTerminalWithScrollback(page)

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debug = (window as any).__wt_terminal_debug
      const activeId = (window as any).__wt_get_attached_id?.()
      if (debug?.scrollToBottom && activeId) debug.scrollToBottom(activeId)
    })
    await page.waitForTimeout(50)

    const bounds = await getActivePaneBounds(page)
    const { viewportYBefore, viewportYAfter } = await touchSwipe(page, {
      startY: bounds.top + bounds.height * 0.2,
      endY: bounds.top + bounds.height * 0.7,
    })

    expect(viewportYAfter, `viewportY should decrease: before=${viewportYBefore} after=${viewportYAfter}`)
      .toBeLessThan(viewportYBefore)
  })

  test(`${renderer}: switching sessions on mobile does not auto-focus the terminal`, async ({ page }) => {
    await loadMobileRenderer(page, renderer)
    const id1 = await newSessionMobile(page)
    await waitForPrompt(page, id1)
    const id2 = await newSessionMobile(page)
    await waitForPrompt(page, id2)

    await page.click('.hamburger')
    await expect(page.locator('.sidebar')).toHaveClass(/open/)
    await switchToSession(page, id1)

    const focusInfo = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      return {
        tag: active?.tagName ?? null,
        role: active?.getAttribute('role') ?? null,
        ariaLabel: active?.getAttribute('aria-label') ?? null,
        inActivePane: !!active?.closest('.terminal-pane.active'),
      }
    })

    expect(focusInfo.inActivePane).toBe(false)
    expect(focusInfo.role).not.toBe('textbox')
    expect(focusInfo.ariaLabel).not.toBe('Terminal input')
  })
}

test('mobile sidebar rows are not draggable (touch scroll is not hijacked)', async ({ page }) => {
  await loadMobileRenderer(page, 'xterm')
  for (let i = 0; i < 8; i++) {
    const id = await newSessionMobile(page)
    await waitForPrompt(page, id)
  }

  await page.click('.hamburger')
  await expect(page.locator('.sidebar')).toHaveClass(/open/)

  const info = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.sidebar.open .session-list')
    const firstItem = document.querySelector<HTMLElement>('.sidebar.open .session-item')
    if (!list) throw new Error('no open sidebar .session-list')
    if (!firstItem) throw new Error('no open sidebar .session-item')
    return {
      itemDraggable: firstItem.draggable,
      itemAttr: firstItem.getAttribute('draggable'),
      touchAction: getComputedStyle(list).touchAction,
    }
  })

  expect(info.itemDraggable).toBe(false)
  expect(info.itemAttr).toBe('false')
  expect(info.touchAction).toBe('pan-y')
})

test('opening paste closes arrow pad and keeps it closed', async ({ page }) => {
  await loadMobileRenderer(page, 'xterm')
  const id = await newSessionMobile(page)
  await waitForPrompt(page, id)

  await page.click("button[title='Arrow keys']")
  await expect(page.locator('.arrow-pad-overlay')).toHaveCount(1)

  await page.click("button[title='Paste']")
  await expect(page.locator('.paste-modal')).toHaveCount(1)
  await expect(page.locator('.arrow-pad-overlay')).toHaveCount(0)

  await expect(page.locator('.paste-enter-btn')).toBeVisible()
  await page.click('.paste-enter-btn')
  await expect(page.locator('.paste-modal')).toHaveCount(1)

  await page.click('.paste-modal-close')
  await expect(page.locator('.paste-modal')).toHaveCount(0)
  await expect(page.locator('.arrow-pad-overlay')).toHaveCount(0)
})

test('hotkey editor can switch from special key back to char mode', async ({ page }) => {
  await loadMobileRenderer(page, 'xterm')
  const id = await newSessionMobile(page)
  await waitForPrompt(page, id)

  await page.click("button[title='Macros and shortcuts']")
  await expect(page.locator('.mobile-toolbar-tray')).toHaveCount(1)

  const hotkey = page.locator('.tb-hotkey').first()
  await hotkey.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, pointerId: 1, bubbles: true })
  await page.waitForTimeout(550)
  await hotkey.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, pointerId: 1, bubbles: true })
  await expect(page.locator('.hotkey-editor')).toBeVisible()

  const keySelect = page.locator('.hk-key-select')
  await keySelect.selectOption('esc')
  await expect(page.locator('.hk-key-input')).toHaveCount(0)

  await keySelect.selectOption('__char__')
  await expect(page.locator('.hk-key-input')).toHaveCount(1)
})
