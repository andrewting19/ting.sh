import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionStatus } from '../types'

interface ConnectionHandlers {
  onBinary: (data: ArrayBuffer) => void
  onMessage: (msg: unknown) => void
  onStatusChange: (status: ConnectionStatus) => void
}

export class WSConnection {
  readonly url: string
  private readonly handlers: ConnectionHandlers
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionallyClosed = false

  constructor(url: string, handlers: ConnectionHandlers) {
    this.url = url
    this.handlers = handlers
    this.connect()
  }

  send(obj: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  close(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  forceClose(): void {
    this.ws?.close()
  }

  private connect(): void {
    this.handlers.onStatusChange('reconnecting')
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.handlers.onStatusChange('connected')
    }

    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      if (e.data instanceof ArrayBuffer) {
        this.handlers.onBinary(e.data)
        return
      }
      try {
        this.handlers.onMessage(JSON.parse(e.data as string))
      } catch {
        // ignore malformed control frames
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.intentionallyClosed) return
      this.handlers.onStatusChange('reconnecting')
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, 1500)
    }
  }
}

interface HostConnectionCallbacks {
  onBinary: (hostId: string, data: ArrayBuffer) => void
  onMessage: (hostId: string, msg: unknown) => void
}

export function useHostConnections(callbacks: HostConnectionCallbacks) {
  const [hostStatuses, setHostStatuses] = useState<Map<string, ConnectionStatus>>(new Map())
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const connectionsRef = useRef<Map<string, WSConnection>>(new Map())

  const setHostStatus = useCallback((hostId: string, status: ConnectionStatus) => {
    setHostStatuses((prev) => {
      const current = prev.get(hostId)
      if (current === status) return prev
      const next = new Map(prev)
      next.set(hostId, status)
      return next
    })
  }, [])

  const connect = useCallback((hostId: string, wsUrl: string) => {
    const existing = connectionsRef.current.get(hostId)
    if (existing && existing.url === wsUrl) return
    if (existing) existing.close()
    const connection = new WSConnection(wsUrl, {
      onBinary: (data) => callbacksRef.current.onBinary(hostId, data),
      onMessage: (msg) => callbacksRef.current.onMessage(hostId, msg),
      onStatusChange: (status) => setHostStatus(hostId, status),
    })
    connectionsRef.current.set(hostId, connection)
  }, [setHostStatus])

  const disconnect = useCallback((hostId: string) => {
    const existing = connectionsRef.current.get(hostId)
    if (!existing) return
    existing.close()
    connectionsRef.current.delete(hostId)
    setHostStatuses((prev) => {
      if (!prev.has(hostId)) return prev
      const next = new Map(prev)
      next.delete(hostId)
      return next
    })
  }, [])

  const send = useCallback((hostId: string, obj: object) => {
    connectionsRef.current.get(hostId)?.send(obj)
  }, [])

  const forceClose = useCallback((hostId: string) => {
    connectionsRef.current.get(hostId)?.forceClose()
  }, [])

  useEffect(() => () => {
    for (const connection of connectionsRef.current.values()) {
      connection.close()
    }
    connectionsRef.current.clear()
  }, [])

  return useMemo(() => ({ hostStatuses, connect, disconnect, send, forceClose }), [hostStatuses, connect, disconnect, send, forceClose])
}
