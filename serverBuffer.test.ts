import { describe, expect, test } from 'bun:test'
import { sanitizeReplayBuffer } from './serverBuffer'

describe('sanitizeReplayBuffer', () => {
  test('returns buffer unchanged when not trimmed', () => {
    const input = Buffer.from('hello\nworld\n')
    const output = sanitizeReplayBuffer(input, false)
    expect(output).toEqual(input)
  })

  test('drops the first partial line when trimmed', () => {
    const input = Buffer.from('\x1b[31mBROKEN_PREFIX\nok-line\n')
    const output = sanitizeReplayBuffer(input, true)
    expect(output.toString('utf8')).toBe('ok-line\n')
  })

  test('skips utf8 continuation bytes before line-drop', () => {
    const input = Buffer.from([0x80, 0xbf, 0x41, 0x0a, 0x42, 0x0a])
    const output = sanitizeReplayBuffer(input, true)
    expect(output.toString('utf8')).toBe('B\n')
  })

  test('returns utf8-aligned tail when no newline exists', () => {
    const input = Buffer.from([0x80, 0xbf, 0x43, 0x44])
    const output = sanitizeReplayBuffer(input, true)
    expect(output.toString('utf8')).toBe('CD')
  })
})
