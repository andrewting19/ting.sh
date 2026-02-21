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
    // Set to true in cleanup so the async onclose callback doesn't enqueue
    // a reconnect after the effect has been intentionally torn down.
    // Without this, React StrictMode's double-mount leaves an orphaned timer
    // that opens a duplicate WS connection 500ms after teardown.
    let intentionallyClosed = false

    function connect() {
      setStatus('reconnecting')
      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'

      sendRef.current = (obj) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
      }

      ws.onopen = () => {
        setStatus('connected')
        // Expose a way for tests to force-close the WS (setOffline doesn't
        // reliably affect localhost connections in all browsers).
        if (import.meta.env.DEV) (window as any).__wt_ws_close = () => ws.close()
      }

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          handlersRef.current.onBinary(e.data)
        } else {
          try { handlersRef.current.onMessage(JSON.parse(e.data as string)) } catch { /* ignore */ }
        }
      }

      ws.onclose = () => {
        if (intentionallyClosed) return
        setStatus('reconnecting')
        timer = setTimeout(connect, 1500)
      }
    }

    connect()
    return () => {
      intentionallyClosed = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [url])

  const send = useCallback((obj: object) => sendRef.current(obj), [])
  return { send, status }
}
