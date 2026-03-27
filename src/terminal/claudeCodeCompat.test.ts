import { expect, test } from 'bun:test'
import {
  collectClaudeCodeCompatStats,
  findSyncOutputEnter,
  findSyncOutputExit,
  shouldDropClaudeCodeResizeSyncBatch,
} from './claudeCodeCompat'

const encoder = new TextEncoder()

test('detects sync-output markers in a batch', () => {
  const data = encoder.encode('hello\u001b[?2026hworld\u001b[?2026lbye')
  expect(findSyncOutputEnter(data)).toBeGreaterThanOrEqual(0)
  expect(findSyncOutputExit(data)).toBeGreaterThan(findSyncOutputEnter(data))
})

test('does not drop ordinary sync-output redraw batches', () => {
  const data = encoder.encode(`\u001b[?2026hhello\r\nworld\r\nstatus: ok\u001b[?2026l`)
  expect(shouldDropClaudeCodeResizeSyncBatch(data)).toBe(false)
})

test('drops pathological resize-time blank redraw batches', () => {
  const blankRun = '\r\r\n'.repeat(512)
  const body = '\u001b[2C\u001b[4A> claude status\n'
  const data = encoder.encode(`\u001b[?2026h${blankRun}${body}\u001b[?2026l`)
  expect(shouldDropClaudeCodeResizeSyncBatch(data)).toBe(true)
  expect(collectClaudeCodeCompatStats(data).blankAdvanceCount).toBe(512)
})

test('does not drop large batches without sync-output markers', () => {
  const data = encoder.encode(`${'\r\r\n'.repeat(700)}footer redraw`)
  expect(shouldDropClaudeCodeResizeSyncBatch(data)).toBe(false)
})
