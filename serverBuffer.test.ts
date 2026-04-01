import { describe, expect, test } from 'bun:test'
import { getReplayBufferStats, sanitizeReplayBuffer } from './serverBuffer'

describe('sanitizeReplayBuffer', () => {
  test('leaves untrimmed buffers unchanged', () => {
    const buffer = Buffer.from('hello\nworld\n')
    expect(sanitizeReplayBuffer(buffer, false)).toEqual(buffer)
  })

  test('drops the first partial line when trimmed', () => {
    const buffer = Buffer.from('rtial line\nfull line\n')
    expect(sanitizeReplayBuffer(buffer, true).toString('utf8')).toBe('full line\n')
  })
})

describe('getReplayBufferStats', () => {
  test('reports replay bytes and line breaks after sanitization', () => {
    const stats = getReplayBufferStats(Buffer.from('broken\nline 1\nline 2\n'), true)
    expect(stats.replay.toString('utf8')).toBe('line 1\nline 2\n')
    expect(stats.replayBytes).toBe(Buffer.byteLength('line 1\nline 2\n'))
    expect(stats.replayLineBreaks).toBe(2)
    expect(stats.replayTrimmed).toBe(true)
  })
})
