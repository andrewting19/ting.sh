import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { WSConnection } from './useHostConnections'
import type { ConnectionStatus } from '../types'

type TimeoutCallback = () => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  binaryType: BinaryType = 'blob'
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.call(this as unknown as WebSocket, new Event('open'))
  }

  emitMessage(data: unknown): void {
    this.onmessage?.call(this as unknown as WebSocket, { data } as MessageEvent)
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.call(this as unknown as WebSocket, {} as CloseEvent)
  }
}

function makeHandlers() {
  const statuses: ConnectionStatus[] = []
  const binaries: ArrayBuffer[] = []
  const messages: unknown[] = []
  return {
    statuses,
    binaries,
    messages,
    handlers: {
      onBinary: (data: ArrayBuffer) => binaries.push(data),
      onMessage: (msg: unknown) => messages.push(msg),
      onStatusChange: (status: ConnectionStatus) => statuses.push(status),
    },
  }
}

describe('WSConnection', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  let nextTimerId = 1
  let timers = new Map<number, TimeoutCallback>()

  const runNextTimer = () => {
    const first = timers.keys().next()
    if (first.done) return false
    const id = first.value
    const cb = timers.get(id)
    if (!cb) return false
    timers.delete(id)
    cb()
    return true
  }

  beforeEach(() => {
    FakeWebSocket.instances = []
    nextTimerId = 1
    timers = new Map()

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.setTimeout = ((cb: TimerHandler) => {
      if (typeof cb !== 'function') throw new Error('Expected function timer callback')
      const id = nextTimerId++
      timers.set(id, cb as TimeoutCallback)
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number)
    }) as typeof clearTimeout
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })

  test('ignores stale messages from a socket closed before reconnect', () => {
    const { binaries, messages, handlers, statuses } = makeHandlers()
    const connection = new WSConnection('ws://example.test/ws', handlers)
    const first = FakeWebSocket.instances[0]!

    first.emitOpen()
    first.emitClose()
    expect(runNextTimer()).toBe(true)

    const second = FakeWebSocket.instances[1]!
    second.emitOpen()

    const staleBytes = new Uint8Array([1, 2, 3]).buffer
    first.emitMessage(staleBytes)
    first.emitMessage(JSON.stringify({ stale: true }))
    expect(binaries).toHaveLength(0)
    expect(messages).toHaveLength(0)

    second.emitMessage(staleBytes)
    second.emitMessage(JSON.stringify({ live: true }))
    expect(binaries).toHaveLength(1)
    expect(messages).toEqual([{ live: true }])
    expect(statuses).toContain('connected')

    connection.close()
  })

  test('ignores stale close events after reconnect', () => {
    const { handlers } = makeHandlers()
    const connection = new WSConnection('ws://example.test/ws', handlers)
    const first = FakeWebSocket.instances[0]!
    first.emitClose()
    expect(runNextTimer()).toBe(true)

    expect(FakeWebSocket.instances).toHaveLength(2)
    const staleCloseCountBefore = timers.size
    first.emitClose()
    expect(timers.size).toBe(staleCloseCountBefore)

    connection.close()
  })
})
