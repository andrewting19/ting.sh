import { expect, test } from 'bun:test'
import { DEFAULT_SERVER_PORT, resolveServerPort } from './serverPort'

test('resolveServerPort reads TING_PORT', () => {
  expect(resolveServerPort({ TING_PORT: '8781' })).toBe(8781)
})

test('resolveServerPort falls back to the default port when TING_PORT is absent or invalid', () => {
  expect(resolveServerPort({})).toBe(DEFAULT_SERVER_PORT)
  expect(resolveServerPort({ TING_PORT: 'abc' })).toBe(DEFAULT_SERVER_PORT)
  expect(resolveServerPort({ TING_PORT: '0' })).toBe(DEFAULT_SERVER_PORT)
})
