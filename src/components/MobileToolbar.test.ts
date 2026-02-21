import { expect, test } from 'bun:test'
import { computeSequence, type HotkeySlot } from './MobileToolbar'

function slot(overrides: Partial<HotkeySlot>): HotkeySlot {
  return {
    id: 'test',
    modifiers: [],
    key: 'x',
    label: 'x',
    ...overrides,
  }
}

test('computeSequence handles ctrl letter mapping', () => {
  expect(computeSequence(slot({ modifiers: ['ctrl'], key: 'c' }))).toBe('\x03')
})

test('computeSequence handles shift+tab mapping', () => {
  expect(computeSequence(slot({ modifiers: ['shift'], key: 'tab' }))).toBe('\x1b[Z')
})

test('computeSequence applies alt as ESC prefix', () => {
  expect(computeSequence(slot({ modifiers: ['alt'], key: 'c' }))).toBe('\x1bc')
  expect(computeSequence(slot({ modifiers: ['alt', 'ctrl'], key: 'c' }))).toBe('\x1b\x03')
})
