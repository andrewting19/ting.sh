import { expect, test } from 'bun:test'
import { getArrowSequence } from './ArrowPad'
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

test('arrow pad uses normal cursor-key sequences by default', () => {
  expect(getArrowSequence('up')).toBe('\x1b[A')
  expect(getArrowSequence('left')).toBe('\x1b[D')
})

test('arrow pad can emit application cursor-key sequences', () => {
  expect(getArrowSequence('up', true)).toBe('\x1bOA')
  expect(getArrowSequence('right', true)).toBe('\x1bOC')
})
