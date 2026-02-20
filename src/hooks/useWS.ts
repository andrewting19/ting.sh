import { useEffect, useRef, useState, useCallback } from 'react'
import type { ConnectionStatus } from '../types'

interface WSHandlers {
  onBinary: (data: ArrayBuffer) => void
  onMessage: (msg: unknown) => void
}

export function useWS(url: string, handlers: WSHandlers) {
  const [status, setStatus] = useState<ConnectionStatus>('reconnecting')
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const sendRef = useRef<(obj: object) => void>(() => {})

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let ws: WebSocket

    function connect() {
      setStatus('reconnecting')
      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'

      sendRef.current = (obj) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
      }

      ws.onopen = () => setStatus('connected')

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          handlersRef.current.onBinary(e.data)
        } else {
          try { handlersRef.current.onMessage(JSON.parse(e.data as string)) } catch { /* ignore */ }
        }
      }

      ws.onclose = () => {
        setStatus('reconnecting')
        timer = setTimeout(connect, 1500)
      }
    }

    connect()
    return () => {
      clearTimeout(timer)
      ws?.close()
    }
  }, [url])

  const send = useCallback((obj: object) => sendRef.current(obj), [])
  return { send, status }
}
