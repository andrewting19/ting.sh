import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Modal } from './components/Modal'
import { MobileToolbar } from './components/MobileToolbar'
import { useHostConnections } from './hooks/useHostConnections'
import { useTerminalManager } from './hooks/useTerminalManager'
import type { ConnectionStatus, Host, Session, SessionKey } from './types'
import { makeKey, parseKey } from './types'
import './App.css'

const LOCAL_HOST_ID = 'local'
type PendingRequest = { hostId: string; requestId: string; kind: 'attach' | 'create' }

export function App() {
  const [hosts, setHosts] = useState<Host[]>([{ id: LOCAL_HOST_ID, name: 'Local Host', url: location.origin, local: true }])
  const [hostSessions, setHostSessions] = useState<Map<string, Session[]>>(new Map())
  const [currentKey, setCurrentKey] = useState<SessionKey | null>(null)
  const [killTargetKey, setKillTargetKey] = useState<SessionKey | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const localHostId = hosts.find(h => h.local)?.id ?? LOCAL_HOST_ID
  const sessions = hostSessions.get(localHostId) ?? []
  const currentId = currentKey ? parseKey(currentKey).sessionId : null

  // Sync refs for use inside callbacks (avoid stale closures)
  const currentKeyRef = useRef<SessionKey | null>(null)
  const hostSessionsRef = useRef<Map<string, Session[]>>(new Map())
  const sessionOrderRef = useRef<SessionKey[]>([])
  currentKeyRef.current = currentKey
  hostSessionsRef.current = hostSessions
  // sessionOrderRef.current is assigned after sessionOrder useState below

  // Session currently attached on the server for this WS connection.
  // Binary output always routes here (never to optimistic UI state).
  const attachedKeyRef = useRef<SessionKey | null>(null)
  // Latest in-flight attach request. Older ready responses are ignored.
  const pendingRequestRef = useRef<PendingRequest | null>(null)
  const pendingAttachTargetKeyRef = useRef<SessionKey | null>(null)
  const nextRequestSeqRef = useRef(0)
  // When we ignore a stale attach ready, drop binary until the newest attach
  // is confirmed so replay from the stale attach cannot contaminate terminals.
  const dropBinaryUntilReadyRef = useRef(false)

  // When set, the next ready response is a duplicate — insert after this ID
  const duplicateSourceKeyRef = useRef<SessionKey | null>(null)

  // Track sessions killed this WS connection to avoid attaching to dead ones
  // during cascading kills (e.g. killAllSessions sends bulk kill messages)
  const killedSessionKeys = useRef<Set<SessionKey>>(new Set())

  // URL hash routing: only do the initial hash navigation once, after the
  // first non-empty sessions list arrives from the server.
  const hasHandledInitialHashRef = useRef(false)

  // Client-side session order (persisted to localStorage for drag-and-drop etc.)
  const [sessionOrder, setSessionOrder] = useState<SessionKey[]>(() => {
    try { return JSON.parse(localStorage.getItem('wt-session-order') ?? '[]') as SessionKey[] } catch { return [] }
  })
  sessionOrderRef.current = sessionOrder

  useEffect(() => {
    localStorage.setItem('wt-session-order', JSON.stringify(sessionOrder))
  }, [sessionOrder])

  // Merge server session list into our local order:
  // keep existing order, drop dead sessions, append new ones at end.
  // Skip when sessions is empty (initial state before WS connects) to avoid
  // wiping the localStorage-restored order before we have real data.
  useEffect(() => {
    const allKeys = [...hostSessions.values()].flatMap(list => list.map(s => makeKey(localHostId, s.id)))
    if (allKeys.length === 0) return
    setSessionOrder(prev => {
      const ids = new Set(allKeys)
      const kept = prev.filter(key => ids.has(key))
      const keptSet = new Set(kept)
      const added = allKeys.filter(key => !keptSet.has(key))
      return [...kept, ...added]
    })
  }, [hostSessions, localHostId])

  const orderedSessions = useMemo(() =>
    [...sessions].sort((a, b) => {
      const ai = sessionOrder.indexOf(makeKey(localHostId, a.id))
      const bi = sessionOrder.indexOf(makeKey(localHostId, b.id))
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    }),
  [sessions, sessionOrder, localHostId])

  // Per-session container refs — one div per session, always in DOM
  const containerRefs = useRef<Map<SessionKey, HTMLDivElement>>(new Map())

  const getSessionByKey = useCallback((key: SessionKey): Session | null => {
    const { hostId, sessionId } = parseKey(key)
    return hostSessionsRef.current.get(hostId)?.find(s => s.id === sessionId) ?? null
  }, [])

  const { hostStatuses, connect, disconnect, send: sendToHost, forceClose } = useHostConnections({
    onBinary: (hostId, data) => {
      if (dropBinaryUntilReadyRef.current) return
      const key = attachedKeyRef.current
      if (!key) return
      if (parseKey(key).hostId !== hostId) return
      tm.write(key, new Uint8Array(data))
    },
    onMessage: (hostId, msg) => handleMessage(hostId, msg),
  })

  const tm = useTerminalManager({
    onData: (sessionKey, data) => {
      if (sessionKey !== currentKeyRef.current) return
      sendToHost(parseKey(sessionKey).hostId, { type: 'input', data })
    },
    onResize: (sessionKey, cols, rows) => {
      if (sessionKey !== currentKeyRef.current) return
      sendToHost(parseKey(sessionKey).hostId, { type: 'resize', cols, rows })
    },
  })

  const sendAttachRequest = useCallback((key: SessionKey) => {
    const requestId = `attach-${++nextRequestSeqRef.current}`
    const { hostId, sessionId } = parseKey(key)
    pendingRequestRef.current = { hostId, requestId, kind: 'attach' }
    pendingAttachTargetKeyRef.current = key
    dropBinaryUntilReadyRef.current = false
    const dims = tm.getDimensions(key)
    sendToHost(hostId, { type: 'attach', id: sessionId, requestId, ...dims })
  }, [sendToHost, tm])

  const syncSessionSize = useCallback((key: SessionKey) => {
    const container = containerRefs.current.get(key)
    if (container) tm.ensureTerminal(key, container)
    tm.setActive(key)
    const dims = tm.getDimensions(key)
    sendToHost(parseKey(key).hostId, { type: 'resize', cols: dims.cols, rows: dims.rows })
    return dims
  }, [sendToHost, tm])

  // Expose send on window in dev so Playwright tests can send WS messages
  // directly (e.g. bulk-kill sessions) without driving the UI.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as any).__wt_send = (obj: object) => sendToHost(localHostId, obj)
    ;(window as any).__wt_ws_close = () => forceClose(localHostId)
    ;(window as any).__wt_get_attached_id = () => {
      const key = attachedKeyRef.current
      return key ? parseKey(key).sessionId : null
    }
  }, [forceClose, localHostId, sendToHost])

  const toWsUrl = useCallback((baseUrl: string) => {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const next = new URL(baseUrl)
    next.protocol = wsProtocol
    next.pathname = '/ws'
    next.search = ''
    next.hash = ''
    return next.toString()
  }, [])

  useEffect(() => {
    for (const host of hosts) connect(host.id, toWsUrl(host.local ? location.origin : host.url))
    for (const hostId of hostStatuses.keys()) {
      if (!hosts.some(host => host.id === hostId)) disconnect(hostId)
    }
  }, [connect, disconnect, hostStatuses, hosts, toWsUrl])

  useEffect(() => {
    let cancelled = false
    const loadHosts = async () => {
      try {
        const res = await fetch('/api/host')
        if (!res.ok) return
        const json = await res.json() as { self: { id: string; name: string }; peers: Array<{ id: string; name: string; url: string }> }
        if (cancelled) return
        setHosts([
          { id: LOCAL_HOST_ID, name: json.self.name || 'Local Host', url: location.origin, local: true },
          ...json.peers.map(peer => ({ id: peer.id, name: peer.name, url: peer.url, local: false })),
        ])
      } catch {
        // stay in single-host fallback mode
      }
    }
    void loadHosts()

    return () => {
      cancelled = true
    }
  }, [])

  const prevStatusesRef = useRef<Map<string, ConnectionStatus>>(new Map())
  useEffect(() => {
    for (const host of hosts) {
      const prev = prevStatusesRef.current.get(host.id)
      const next = hostStatuses.get(host.id)
      if (next === 'connected' && prev !== 'connected') {
        killedSessionKeys.current.clear()
        sendToHost(host.id, { type: 'list' })
        const key = currentKeyRef.current
        if (key && parseKey(key).hostId === host.id) {
          const container = containerRefs.current.get(key)
          if (container) tm.ensureTerminal(key, container)
          tm.setActive(key)
          tm.reset(key)
          sendAttachRequest(key)
        }
      }
      if (prev === 'connected' && next !== 'connected') {
        if (pendingRequestRef.current?.hostId === host.id) {
          pendingRequestRef.current = null
          pendingAttachTargetKeyRef.current = null
          dropBinaryUntilReadyRef.current = false
        }
        if (attachedKeyRef.current && parseKey(attachedKeyRef.current).hostId === host.id) {
          attachedKeyRef.current = null
        }
      }
    }
    prevStatusesRef.current = new Map(hostStatuses)
  }, [hostStatuses, hosts, sendAttachRequest, sendToHost, tm])

  // When currentId changes (or sessions list grows), activate the terminal.
  // sessions.length is included so this re-runs when the new session's div
  // appears in the DOM — needed because for new sessions the div doesn't exist
  // yet when ready arrives (sessions broadcast hadn't been processed by React).
  useEffect(() => {
    if (!currentKey) return
    syncSessionSize(currentKey)
    tm.focus(currentKey)
  }, [currentKey, sessions.length, syncSessionSize, tm])

  // If another client resized the shared PTY while this tab was in the
  // background (e.g. phone <-> desktop), reclaim local dimensions on return.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden') return
      const key = currentKeyRef.current
      if (!key) return
      syncSessionSize(key)
    }
    document.addEventListener('visibilitychange', handler)
    window.addEventListener('focus', handler)
    return () => {
      document.removeEventListener('visibilitychange', handler)
      window.removeEventListener('focus', handler)
    }
  }, [syncSessionSize])

  // hashchange: if the user manually edits the URL hash, navigate to that session
  useEffect(() => {
    const handler = () => {
      const hashVal = decodeURIComponent(location.hash.slice(1))
      const list = hostSessionsRef.current.get(localHostId) ?? []
      const s = list.find(session => session.name === hashVal) ?? list.find(session => session.id === hashVal)
      if (s) attachSession(makeKey(localHostId, s.id))
    }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [localHostId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Use e.code (physical key) not e.key — on macOS, Option remaps keys at
      // the OS level so e.key is '†'/'∑'/'¡' instead of 't'/'w'/'1'.
      if (e.altKey && e.code === 'KeyT') { e.preventDefault(); newSession() }
      if (e.altKey && e.code === 'KeyW') {
        e.preventDefault()
        const key = currentKeyRef.current
        if (key) setKillTargetKey(key)
      }
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault()
        const ordered = [...(hostSessionsRef.current.get(localHostId) ?? [])].sort((a, b) => {
          const ai = sessionOrderRef.current.indexOf(makeKey(localHostId, a.id))
          const bi = sessionOrderRef.current.indexOf(makeKey(localHostId, b.id))
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        })
        const s = ordered[parseInt(e.code[5]) - 1]
        if (s) attachSession(makeKey(localHostId, s.id))
      }
    }
    // Capture phase (true) so we intercept before xterm.js, which consumes
    // certain Alt combos (e.g. Alt+W = readline cut-word) and stops propagation.
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [localHostId]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleMessage(hostId: string, msg: unknown) {
    const m = msg as Record<string, unknown>
    switch (m.type) {
      case 'host-info': {
        const name = typeof m.name === 'string' && m.name.trim().length > 0 ? m.name : null
        if (!name) break
        setHosts(prev => prev.map(host => host.id === hostId ? { ...host, name } : host))
        break
      }

      case 'sessions': {
        const list = (m.list as Session[]).map(s => ({ ...s, hostId }))
        setHostSessions(prev => {
          const next = new Map(prev)
          next.set(hostId, list)
          return next
        })
        // After the first real sessions list arrives, navigate to the #hash
        // session if one is present in the URL (deeplink / bookmark support).
        if (!hasHandledInitialHashRef.current && list.length > 0 && (hostId === localHostId || hosts.length === 1)) {
          hasHandledInitialHashRef.current = true
          const hashVal = decodeURIComponent(location.hash.slice(1))
          // Match by name first, fall back to ID (for old bookmarks),
          // then fall back to first session if no hash present
          const match = list.find(s => s.name === hashVal)
            ?? list.find(s => s.id === hashVal)
            ?? list[0]
          attachSession(makeKey(hostId, match.id))
        }
        break
      }

      case 'ready': {
        const id = m.id as string
        const name = m.name as string
        let key: SessionKey | null = pendingAttachTargetKeyRef.current
        const requestId = typeof m.requestId === 'string' ? m.requestId : null
        if (requestId) {
          const pending = pendingRequestRef.current
          if (!pending) return
          if (requestId !== pending.requestId || pending.hostId !== hostId) {
            dropBinaryUntilReadyRef.current = true
            return
          }
          pendingRequestRef.current = null
          pendingAttachTargetKeyRef.current = null
          dropBinaryUntilReadyRef.current = false
          if (pending.kind === 'create') key = makeKey(pending.hostId, id)
        } else {
          pendingRequestRef.current = null
          pendingAttachTargetKeyRef.current = null
          dropBinaryUntilReadyRef.current = false
        }
        if (!key) key = makeKey(hostId, id)
        attachedKeyRef.current = key
        // Update sync ref immediately so binary routing is correct
        currentKeyRef.current = key
        // Prime the terminal immediately so it buffers incoming binary before
        // React re-renders and the container div is available for ensureTerminal.
        // Without this, shell startup output (prompt) is dropped when there was
        // no previous session to route binary to (e.g. first session after
        // killAllSessions in tests, or fresh page load).
        tm.primeTerminal(key)
        setCurrentKey(key)
        // Update hash — use name from payload (sessions state may not have
        // updated yet since setSessions is async)
        history.replaceState(null, '', '#' + encodeURIComponent(name))

        // If this was a duplicate, insert the new session right after its source
        if (duplicateSourceKeyRef.current) {
          const sourceKey = duplicateSourceKeyRef.current
          duplicateSourceKeyRef.current = null
          setSessionOrder(prev => {
            const next = prev.filter(x => x !== key)
            const sourceIdx = next.indexOf(sourceKey)
            if (sourceIdx !== -1) next.splice(sourceIdx + 1, 0, key)
            else next.push(key)
            return next
          })
        }

        break
      }

      case 'error': {
        const requestId = typeof m.requestId === 'string' ? m.requestId : null
        if (!requestId || requestId !== pendingRequestRef.current?.requestId || hostId !== pendingRequestRef.current.hostId) break
        pendingRequestRef.current = null
        pendingAttachTargetKeyRef.current = null
        dropBinaryUntilReadyRef.current = false
        const fallback = attachedKeyRef.current
        currentKeyRef.current = fallback
        setCurrentKey(fallback)
        if (fallback) {
          tm.setActive(fallback)
          tm.focus(fallback)
          const name = getSessionByKey(fallback)?.name ?? parseKey(fallback).sessionId
          history.replaceState(null, '', '#' + encodeURIComponent(name))
        } else {
          history.replaceState(null, '', location.pathname)
        }
        break
      }

      case 'session-exit': {
        const id = m.id as string
        const key = makeKey(hostId, id)
        killedSessionKeys.current.add(key)
        if (attachedKeyRef.current === key) attachedKeyRef.current = null
        if (pendingAttachTargetKeyRef.current === key) {
          pendingRequestRef.current = null
          pendingAttachTargetKeyRef.current = null
          dropBinaryUntilReadyRef.current = false
        }
        tm.destroy(key)
        setHostSessions(prev => {
          const next = new Map(prev)
          const list = next.get(hostId) ?? []
          next.set(hostId, list.filter(s => s.id !== id))
          return next
        })
        if (currentKeyRef.current === key) {
          currentKeyRef.current = null
          setCurrentKey(null)
          history.replaceState(null, '', location.pathname)
          // Auto-attach to nearest surviving session
          const remaining = (hostSessionsRef.current.get(hostId) ?? [])
            .filter(s => s.id !== id && !killedSessionKeys.current.has(makeKey(hostId, s.id)))
          if (remaining.length > 0) {
            const order = sessionOrderRef.current
            const killedIdx = order.indexOf(key)
            const ordered = [...remaining].sort((a, b) => {
              const ai = order.indexOf(makeKey(hostId, a.id))
              const bi = order.indexOf(makeKey(hostId, b.id))
              return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
            })
            // Prefer the session that was right after the killed one; fall back to last
            const next = ordered.find(s => order.indexOf(makeKey(hostId, s.id)) > killedIdx) ?? ordered[ordered.length - 1]
            attachSession(makeKey(hostId, next.id))
          }
        }
        break
      }
    }
  }

  function newSession(cwd?: string) {
    const dims = currentKeyRef.current
      ? tm.getDimensions(currentKeyRef.current)
      : { cols: 80, rows: 24 }
    const targetHostId = currentKeyRef.current ? parseKey(currentKeyRef.current).hostId : localHostId
    const requestId = `create-${++nextRequestSeqRef.current}`
    pendingRequestRef.current = { hostId: targetHostId, requestId, kind: 'create' }
    pendingAttachTargetKeyRef.current = null
    dropBinaryUntilReadyRef.current = false
    sendToHost(targetHostId, { type: 'create', requestId, ...(cwd ? { cwd } : {}), ...dims })
  }

  function duplicateSession(sourceId: string) {
    const source = (hostSessionsRef.current.get(localHostId) ?? []).find(s => s.id === sourceId)
    duplicateSourceKeyRef.current = makeKey(localHostId, sourceId)
    newSession(source?.cwd || undefined)
  }

  function attachSession(key: SessionKey) {
    if (key === currentKeyRef.current) {
      syncSessionSize(key)
      tm.focus(key)
      return
    }
    const currentHostId = currentKeyRef.current ? parseKey(currentKeyRef.current).hostId : null
    const nextHostId = parseKey(key).hostId
    if (currentHostId && currentHostId !== nextHostId) {
      sendToHost(currentHostId, { type: 'detach' })
    }
    const container = containerRefs.current.get(key)
    if (container) tm.ensureTerminal(key, container)
    // Clear existing content — server always replays the full scrollback buffer
    // on every attach, so we must reset first to avoid duplication.
    tm.reset(key)
    // Optimistic: make pane visible immediately so focus() fires within the
    // user gesture (required for iOS keyboard), without waiting for ready.
    currentKeyRef.current = key
    setCurrentKey(key)
    tm.setActive(key)
    tm.focus(key)
    sendAttachRequest(key)
    // Update URL hash for bookmarking / deeplink — use name not UUID
    const name = getSessionByKey(key)?.name ?? parseKey(key).sessionId
    history.replaceState(null, '', '#' + encodeURIComponent(name))
  }

  function killSession(key: SessionKey) {
    const { hostId, sessionId } = parseKey(key)
    sendToHost(hostId, { type: 'kill', id: sessionId })
    setKillTargetKey(null)
  }

  function renameSession(id: string, name: string) {
    const key = makeKey(localHostId, id)
    setHostSessions(prev => {
      const next = new Map(prev)
      const list = next.get(localHostId) ?? []
      next.set(localHostId, list.map(s => s.id === id ? { ...s, name } : s))
      return next
    })
    sendToHost(localHostId, { type: 'rename', id, name })
    // Keep URL hash in sync if this is the current session
    if (key === currentKeyRef.current) {
      history.replaceState(null, '', '#' + encodeURIComponent(name))
    }
  }

  function reorderSessions(fromId: string, toId: string) {
    const fromKey = makeKey(localHostId, fromId)
    const toKey = makeKey(localHostId, toId)
    setSessionOrder(prev => {
      const next = prev.filter(key => key !== fromKey)
      const toIdx = next.indexOf(toKey)
      next.splice(toIdx, 0, fromKey)
      return next
    })
  }

  function reorderSessionToEnd(fromId: string) {
    const fromKey = makeKey(localHostId, fromId)
    setSessionOrder(prev => [...prev.filter(key => key !== fromKey), fromKey])
  }

  function sendInput(data: string) {
    const key = currentKeyRef.current
    if (!key) return
    sendToHost(parseKey(key).hostId, { type: 'input', data })
  }

  function scrollToBottom() {
    const key = currentKeyRef.current
    if (!key) return
    const container = containerRefs.current.get(key)
    const viewport = container?.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }

  const killTarget = killTargetKey ? getSessionByKey(killTargetKey) : null
  const sidebarHostId = currentKey ? parseKey(currentKey).hostId : localHostId
  const status: ConnectionStatus = hostStatuses.get(sidebarHostId) ?? 'reconnecting'

  return (
    <div className="app">
      <header className="header">
        <button className="hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle sidebar">
          <span /><span /><span />
        </button>
        <div className="wordmark">web<span>—</span>terminal</div>
      </header>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <Sidebar
        sessions={orderedSessions}
        currentId={currentId}
        status={status}
        isOpen={sidebarOpen}
        onNew={() => newSession()}
        onAttach={(id) => { attachSession(makeKey(localHostId, id)); setSidebarOpen(false) }}
        onKill={(id) => setKillTargetKey(makeKey(localHostId, id))}
        onRename={renameSession}
        onDuplicate={duplicateSession}
        onReorder={reorderSessions}
        onReorderToEnd={reorderSessionToEnd}
      />

      <main className="main">
        {!currentId && (
          <div className="no-session">
            <div className="no-session-prompt">no active session</div>
            <button className="no-session-btn" onClick={() => newSession()}>new session</button>
          </div>
        )}

        {/* One container per session — always in DOM, stacked absolutely.
            Lazy: xterm.js instance is created only when the session is first viewed. */}
        <div className="terminal-area">
          {sessions.map(s => {
            const key = makeKey(localHostId, s.id)
            return (
            <div
              key={key}
              ref={el => {
                if (el) containerRefs.current.set(key, el)
                else containerRefs.current.delete(key)
              }}
              className={`terminal-pane${key === currentKey ? ' active' : ''}`}
            />
            )
          })}
        </div>
      </main>

      <MobileToolbar
        currentId={currentId}
        sendInput={sendInput}
        focusTerminal={() => { if (currentKey) tm.focus(currentKey) }}
        scrollToBottom={scrollToBottom}
      />

      {killTarget && (
        <Modal
          title="Kill session"
          message={`Kill "${killTarget.name}"?`}
          confirmLabel="Kill"
          onConfirm={() => { if (killTargetKey) killSession(killTargetKey) }}
          onCancel={() => setKillTargetKey(null)}
        />
      )}
    </div>
  )
}
