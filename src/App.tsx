import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Modal } from './components/Modal'
import { MobileToolbar } from './components/MobileToolbar'
import { useWS } from './hooks/useWS'
import { useTerminalManager } from './hooks/useTerminalManager'
import type { Session } from './types'
import './App.css'

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [killTarget, setKillTarget] = useState<Session | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Sync refs for use inside callbacks (avoid stale closures)
  const currentIdRef = useRef<string | null>(null)
  const sessionsRef = useRef<Session[]>([])
  const sessionOrderRef = useRef<string[]>([])
  currentIdRef.current = currentId
  sessionsRef.current = sessions
  // sessionOrderRef.current is assigned after sessionOrder useState below

  // Set when we've sent attach/create but haven't received ready yet.
  // Binary scrollback arrives before ready, so we route it here.
  const attachingIdRef = useRef<string | null>(null)

  // When set, the next ready response is a duplicate — insert after this ID
  const duplicateSourceRef = useRef<string | null>(null)

  // Track sessions killed this WS connection to avoid attaching to dead ones
  // during cascading kills (e.g. killAllSessions sends bulk kill messages)
  const killedSessionIds = useRef<Set<string>>(new Set())

  // URL hash routing: only do the initial hash navigation once, after the
  // first non-empty sessions list arrives from the server.
  const hasHandledInitialHashRef = useRef(false)

  // Client-side session order (persisted to localStorage for drag-and-drop etc.)
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('wt-session-order') ?? '[]') } catch { return [] }
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
    if (sessions.length === 0) return
    setSessionOrder(prev => {
      const ids = new Set(sessions.map(s => s.id))
      const kept = prev.filter(id => ids.has(id))
      const keptSet = new Set(kept)
      const added = sessions.map(s => s.id).filter(id => !keptSet.has(id))
      return [...kept, ...added]
    })
  }, [sessions])

  const orderedSessions = useMemo(() =>
    [...sessions].sort((a, b) => {
      const ai = sessionOrder.indexOf(a.id)
      const bi = sessionOrder.indexOf(b.id)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    }),
  [sessions, sessionOrder])

  // Per-session container refs — one div per session, always in DOM
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const tm = useTerminalManager({
    onData: (_sessionId, data) => send({ type: 'input', data }),
    onResize: (sessionId, cols, rows) => {
      if (sessionId === currentIdRef.current) send({ type: 'resize', cols, rows })
    },
  })

  const { send, status } = useWS(`ws://${location.host}/ws`, {
    onBinary: (data) => {
      // Route to the session we're transitioning to, or the current one
      const id = attachingIdRef.current ?? currentIdRef.current
      if (id) tm.write(id, new Uint8Array(data))
    },
    onMessage: handleMessage,
  })

  const syncSessionSize = useCallback((id: string) => {
    const container = containerRefs.current.get(id)
    if (container) tm.ensureTerminal(id, container)
    tm.setActive(id)
    const dims = tm.getDimensions(id)
    send({ type: 'resize', cols: dims.cols, rows: dims.rows })
    return dims
  }, [send, tm])

  // Expose send on window in dev so Playwright tests can send WS messages
  // directly (e.g. bulk-kill sessions) without driving the UI.
  useEffect(() => {
    if (import.meta.env.DEV) (window as any).__wt_send = send
  }, [send])

  // On (re)connect: request session list and re-attach current session
  useEffect(() => {
    if (status !== 'connected') return
    killedSessionIds.current.clear()
    send({ type: 'list' })
    const id = currentIdRef.current
    if (id) {
      attachingIdRef.current = id
      const container = containerRefs.current.get(id)
      if (container) tm.ensureTerminal(id, container)
      tm.setActive(id)
      tm.reset(id)
      const dims = tm.getDimensions(id)
      send({ type: 'attach', id, ...dims })
    }
  }, [status, send, tm])

  // When currentId changes (or sessions list grows), activate the terminal.
  // sessions.length is included so this re-runs when the new session's div
  // appears in the DOM — needed because for new sessions the div doesn't exist
  // yet when ready arrives (sessions broadcast hadn't been processed by React).
  useEffect(() => {
    if (!currentId) return
    syncSessionSize(currentId)
    tm.focus(currentId)
  }, [currentId, sessions.length, syncSessionSize, tm])

  // If another client resized the shared PTY while this tab was in the
  // background (e.g. phone <-> desktop), reclaim local dimensions on return.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden') return
      const id = currentIdRef.current
      if (!id) return
      syncSessionSize(id)
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
      const s = sessionsRef.current.find(s => s.name === hashVal) ?? sessionsRef.current.find(s => s.id === hashVal)
      if (s) attachSession(s.id)
    }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Use e.code (physical key) not e.key — on macOS, Option remaps keys at
      // the OS level so e.key is '†'/'∑'/'¡' instead of 't'/'w'/'1'.
      if (e.altKey && e.code === 'KeyT') { e.preventDefault(); newSession() }
      if (e.altKey && e.code === 'KeyW') {
        e.preventDefault()
        const id = currentIdRef.current
        const s = sessionsRef.current.find(s => s.id === id)
        if (s) setKillTarget(s)
      }
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault()
        const ordered = [...sessionsRef.current].sort((a, b) => {
          // Use current order from localStorage for shortcut navigation too
          const order: string[] = (() => {
            try { return JSON.parse(localStorage.getItem('wt-session-order') ?? '[]') } catch { return [] }
          })()
          return (order.indexOf(a.id) ?? 999) - (order.indexOf(b.id) ?? 999)
        })
        const s = ordered[parseInt(e.code[5]) - 1]
        if (s) attachSession(s.id)
      }
    }
    // Capture phase (true) so we intercept before xterm.js, which consumes
    // certain Alt combos (e.g. Alt+W = readline cut-word) and stops propagation.
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleMessage(msg: unknown) {
    const m = msg as Record<string, unknown>
    switch (m.type) {
      case 'sessions': {
        const list = m.list as Session[]
        setSessions(list)
        // After the first real sessions list arrives, navigate to the #hash
        // session if one is present in the URL (deeplink / bookmark support).
        if (!hasHandledInitialHashRef.current && list.length > 0) {
          hasHandledInitialHashRef.current = true
          const hashVal = decodeURIComponent(location.hash.slice(1))
          // Match by name first, fall back to ID (for old bookmarks),
          // then fall back to first session if no hash present
          const match = list.find(s => s.name === hashVal)
            ?? list.find(s => s.id === hashVal)
            ?? list[0]
          attachSession(match.id)
        }
        break
      }

      case 'ready': {
        const id = m.id as string
        const name = m.name as string
        attachingIdRef.current = null
        // Update sync ref immediately so binary routing is correct
        currentIdRef.current = id
        // Prime the terminal immediately so it buffers incoming binary before
        // React re-renders and the container div is available for ensureTerminal.
        // Without this, shell startup output (prompt) is dropped when there was
        // no previous session to route binary to (e.g. first session after
        // killAllSessions in tests, or fresh page load).
        tm.primeTerminal(id)
        setCurrentId(id)
        // Update hash — use name from payload (sessions state may not have
        // updated yet since setSessions is async)
        history.replaceState(null, '', '#' + encodeURIComponent(name))

        // If this was a duplicate, insert the new session right after its source
        if (duplicateSourceRef.current) {
          const sourceId = duplicateSourceRef.current
          duplicateSourceRef.current = null
          setSessionOrder(prev => {
            const next = prev.filter(x => x !== id)
            const sourceIdx = next.indexOf(sourceId)
            if (sourceIdx !== -1) next.splice(sourceIdx + 1, 0, id)
            else next.push(id)
            return next
          })
        }

        break
      }

      case 'session-exit': {
        const id = m.id as string
        killedSessionIds.current.add(id)
        tm.destroy(id)
        setSessions(s => s.filter(s => s.id !== id))
        if (currentIdRef.current === id) {
          currentIdRef.current = null
          setCurrentId(null)
          history.replaceState(null, '', location.pathname)
          // Auto-attach to nearest surviving session
          const remaining = sessionsRef.current.filter(s => !killedSessionIds.current.has(s.id))
          if (remaining.length > 0) {
            const order = sessionOrderRef.current
            const killedIdx = order.indexOf(id)
            const ordered = [...remaining].sort((a, b) => {
              const ai = order.indexOf(a.id)
              const bi = order.indexOf(b.id)
              return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
            })
            // Prefer the session that was right after the killed one; fall back to last
            const next = ordered.find(s => order.indexOf(s.id) > killedIdx) ?? ordered[ordered.length - 1]
            attachSession(next.id)
          }
        }
        break
      }
    }
  }

  function newSession(cwd?: string) {
    const dims = currentIdRef.current
      ? tm.getDimensions(currentIdRef.current)
      : { cols: 80, rows: 24 }
    send({ type: 'create', ...(cwd ? { cwd } : {}), ...dims })
  }

  function duplicateSession(sourceId: string) {
    const source = sessionsRef.current.find(s => s.id === sourceId)
    duplicateSourceRef.current = sourceId
    newSession(source?.cwd || undefined)
  }

  function attachSession(id: string) {
    if (id === currentIdRef.current) {
      syncSessionSize(id)
      tm.focus(id)
      return
    }
    attachingIdRef.current = id
    const container = containerRefs.current.get(id)
    if (container) tm.ensureTerminal(id, container)
    // Clear existing content — server always replays the full scrollback buffer
    // on every attach, so we must reset first to avoid duplication.
    tm.reset(id)
    // Optimistic: make pane visible immediately so focus() fires within the
    // user gesture (required for iOS keyboard), without waiting for ready.
    currentIdRef.current = id
    setCurrentId(id)
    tm.setActive(id)
    tm.focus(id)
    const dims = tm.getDimensions(id)
    send({ type: 'attach', id, ...dims })
    // Update URL hash for bookmarking / deeplink — use name not UUID
    const name = sessionsRef.current.find(s => s.id === id)?.name ?? id
    history.replaceState(null, '', '#' + encodeURIComponent(name))
  }

  function killSession(id: string) {
    send({ type: 'kill', id })
    setKillTarget(null)
  }

  function renameSession(id: string, name: string) {
    setSessions(s => s.map(s => s.id === id ? { ...s, name } : s))
    send({ type: 'rename', id, name })
    // Keep URL hash in sync if this is the current session
    if (id === currentIdRef.current) {
      history.replaceState(null, '', '#' + encodeURIComponent(name))
    }
  }

  function reorderSessions(fromId: string, toId: string) {
    setSessionOrder(prev => {
      const next = prev.filter(id => id !== fromId)
      const toIdx = next.indexOf(toId)
      next.splice(toIdx, 0, fromId)
      return next
    })
  }

  function reorderSessionToEnd(fromId: string) {
    setSessionOrder(prev => [...prev.filter(id => id !== fromId), fromId])
  }

  function sendInput(data: string) {
    send({ type: 'input', data })
  }

  function scrollToBottom() {
    const id = currentIdRef.current
    if (!id) return
    const container = containerRefs.current.get(id)
    const viewport = container?.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }

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
        onAttach={(id) => { attachSession(id); setSidebarOpen(false) }}
        onKill={(id) => setKillTarget(sessions.find(s => s.id === id) ?? null)}
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
          {sessions.map(s => (
            <div
              key={s.id}
              ref={el => {
                if (el) containerRefs.current.set(s.id, el)
                else containerRefs.current.delete(s.id)
              }}
              className={`terminal-pane${s.id === currentId ? ' active' : ''}`}
            />
          ))}
        </div>
      </main>

      <MobileToolbar
        currentId={currentId}
        sendInput={sendInput}
        focusTerminal={() => { if (currentId) tm.focus(currentId) }}
        scrollToBottom={scrollToBottom}
      />

      {killTarget && (
        <Modal
          title="Kill session"
          message={`Kill "${killTarget.name}"?`}
          confirmLabel="Kill"
          onConfirm={() => killSession(killTarget.id)}
          onCancel={() => setKillTarget(null)}
        />
      )}
    </div>
  )
}
