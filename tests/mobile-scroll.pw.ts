/**
 * Mobile touch-scroll tests — run with iPhone user agent so mobile touch handlers activate.
 *
 * These tests dispatch raw TouchEvent sequences and verify the xterm viewport
 * scrollTop changes.  They run on Chromium (not iOS Safari), so they CANNOT
 * reproduce iOS UIKit's gesture-recognizer behaviour (where touchmove is
 * suppressed while UIKit decides text-selection vs scroll).  What they DO catch:
 *   - The core JS scroll path works: touchmove fires → xterm scrollTop += deltaY
 *   - preventDefault on touchmove (active listener) doesn't break scrolling
 *   - Our momentum rAF loop runs without errors
 *   - Regressions in mobile touch-listener setup / teardown
 *
 * Physical iOS Safari still needs device verification for true gesture behavior;
 * these tests guard our JS path plus renderer configuration.
 */

import { test, expect } from '@playwright/test'
import { waitForPrompt, killAllSessions } from './helpers'
import type { Page } from '@playwright/test'

// Spoof iPhone UA so iOS-specific terminal behavior is active.
test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await killAllSessions(page)
})

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
 * startY > endY  → finger moves up   → content scrolls down  → scrollTop increases
 * startY < endY  → finger moves down → content scrolls up    → scrollTop decreases
 */
async function touchSwipe(
  page: Page,
  opts: { startY: number; endY: number; steps?: number },
): Promise<{ scrollTopBefore: number; scrollTopAfter: number }> {
  const { startY, endY, steps = 10 } = opts

  return page.evaluate(
    ({ startY, endY, steps }) => {
      const container = document.querySelector<HTMLElement>('.terminal-pane.active')
      if (!container) throw new Error('no active .terminal-pane')
      const viewport = container.querySelector<HTMLElement>('.xterm-viewport')
      if (!viewport) throw new Error('no .xterm-viewport')

      const bounds = container.getBoundingClientRect()
      const clientX = bounds.left + bounds.width / 2
      const scrollTopBefore = viewport.scrollTop

      // Dispatch on the viewport element (inside xterm root) so that:
      // - Capture phase reaches .terminal-pane first (our mobile touch handler)
      // - Then the event reaches .xterm in the bubble phase (xterm's handlers)
      // Dispatching from the outer container would not reach xterm's inner listeners.
      const fire = (type: string, y: number) => {
        const touch = new Touch({
          identifier: 1,
          target: viewport,
          clientX,
          clientY: y,
          screenX: clientX,
          screenY: y,
          // pageY must be set explicitly — xterm's handleTouchStart reads
          // ev.touches[0].pageY; if omitted, it defaults to 0 and deltaY=0.
          // Since our app has overflow:hidden, window.scrollY===0 so pageY===clientY.
          pageX: clientX,
          pageY: y,
          radiusX: 10,
          radiusY: 10,
          rotationAngle: 0,
          force: 1,
        })
        viewport.dispatchEvent(
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

      return { scrollTopBefore, scrollTopAfter: viewport.scrollTop }
    },
    { startY, endY, steps },
  )
}

test('iPhone UA uses canvas renderer (no DOM text rows)', async ({ page }) => {
  const id = await newSessionMobile(page)
  await waitForPrompt(page, id)

  await page.waitForFunction(() => {
    const pane = document.querySelector<HTMLElement>('.terminal-pane.active')
    if (!pane) return false
    const canvasCount = pane.querySelectorAll('.xterm-screen canvas').length
    const hasDomRows = !!pane.querySelector('.xterm-rows')
    return canvasCount > 0 && !hasDomRows
  })

  const info = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('.terminal-pane.active')
    if (!pane) throw new Error('no active .terminal-pane')
    return {
      canvasCount: pane.querySelectorAll('.xterm-screen canvas').length,
      hasDomRows: !!pane.querySelector('.xterm-rows'),
    }
  })

  expect(info.canvasCount).toBeGreaterThan(0)
  expect(info.hasDomRows).toBe(false)
})

test('touch swipe up scrolls terminal down (scrollTop increases)', async ({ page }) => {
  const id = await newSessionMobile(page)
  await waitForPrompt(page, id)

  // Produce >1 screenful of output
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__wt_send({ type: 'input', data: 'printf "%0.s\\n" {1..200}\r' })
  })
  await page.waitForTimeout(1500)

  // Ensure viewport starts at top
  await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>('.terminal-pane.active .xterm-viewport')
    if (vp) vp.scrollTop = 0
  })
  await page.waitForTimeout(50)

  const bounds = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.terminal-pane.active')!
    const r = el.getBoundingClientRect()
    return { top: r.top, height: r.height }
  })

  // Finger moves from 70% → 20% of terminal height = swipe up = scroll down
  const { scrollTopBefore, scrollTopAfter } = await touchSwipe(page, {
    startY: bounds.top + bounds.height * 0.7,
    endY:   bounds.top + bounds.height * 0.2,
  })

  expect(scrollTopAfter, `scrollTop should increase: before=${scrollTopBefore} after=${scrollTopAfter}`)
    .toBeGreaterThan(scrollTopBefore)
})

test('touch swipe down scrolls terminal up (scrollTop decreases)', async ({ page }) => {
  const id = await newSessionMobile(page)
  await waitForPrompt(page, id)

  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__wt_send({ type: 'input', data: 'printf "%0.s\\n" {1..200}\r' })
  })
  await page.waitForTimeout(1500)

  // Ensure viewport starts at bottom
  await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>('.terminal-pane.active .xterm-viewport')
    if (vp) vp.scrollTop = vp.scrollHeight
  })
  await page.waitForTimeout(50)

  const bounds = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.terminal-pane.active')!
    const r = el.getBoundingClientRect()
    return { top: r.top, height: r.height }
  })

  // Finger moves from 20% → 70% = swipe down = scroll up
  const { scrollTopBefore, scrollTopAfter } = await touchSwipe(page, {
    startY: bounds.top + bounds.height * 0.2,
    endY:   bounds.top + bounds.height * 0.7,
  })

  expect(scrollTopAfter, `scrollTop should decrease: before=${scrollTopBefore} after=${scrollTopAfter}`)
    .toBeLessThan(scrollTopBefore)
})

test('mobile sidebar rows are not draggable (touch scroll is not hijacked)', async ({ page }) => {
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
