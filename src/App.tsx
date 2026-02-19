import { useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Modal } from './components/Modal'
import { useWS } from './hooks/useWS'
import { useTerminalManager } from './hooks/useTerminalManager'
import type { Session } from './types'
import './App.css'

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [killTarget, setKillTarget] = useState<Session | null>(null)

  // Sync refs for use inside callbacks (avoid stale closures)
  const currentIdRef = useRef<string | null>(null)
  const sessionsRef = useRef<Session[]>([])
  currentIdRef.current = currentId
  sessionsRef.current = sessions

  // Set when we've sent attach/create but haven't received ready yet.
  // Binary scrollback arrives before ready, so we route it here.
  const attachingIdRef = useRef<string | null>(null)

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

  // On (re)connect: request session list and re-attach current session
  useEffect(() => {
    if (status !== 'connected') return
    send({ type: 'list' })
    const id = currentIdRef.current
    if (id) {
      attachingIdRef.current = id
      const container = containerRefs.current.get(id)
      if (container) tm.ensureTerminal(id, container)
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
    const container = containerRefs.current.get(currentId)
    if (container) {
      tm.ensureTerminal(currentId, container)
      tm.setActive(currentId)
      tm.focus(currentId)
    }
  }, [currentId, sessions.length, tm])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 't') { e.preventDefault(); newSession() }
      if (e.altKey && e.key === 'w') {
        e.preventDefault()
        const id = currentIdRef.current
        const s = sessionsRef.current.find(s => s.id === id)
        if (s) setKillTarget(s)
      }
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const s = sessionsRef.current[parseInt(e.key) - 1]
        if (s) attachSession(s.id)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleMessage(msg: unknown) {
    const m = msg as Record<string, unknown>
    switch (m.type) {
      case 'sessions':
        setSessions(m.list as Session[])
        break

      case 'ready': {
        const id = m.id as string
        attachingIdRef.current = null
        // Update sync ref immediately so binary routing is correct
        currentIdRef.current = id
        setCurrentId(id)

        // If fresh (new session), reset the terminal to clear any prior state
        if (m.fresh) tm.reset(id)
        break
      }

      case 'session-exit': {
        const id = m.id as string
        tm.destroy(id)
        setSessions(s => s.filter(s => s.id !== id))
        if (currentIdRef.current === id) {
          currentIdRef.current = null
          setCurrentId(null)
        }
        break
      }
    }
  }

  function newSession() {
    // Dimensions from current session or defaults
    const dims = currentIdRef.current
      ? tm.getDimensions(currentIdRef.current)
      : { cols: 80, rows: 24 }
    send({ type: 'create', ...dims })
  }

  function attachSession(id: string) {
    if (id === currentIdRef.current) return
    attachingIdRef.current = id
    // Ensure terminal exists before scrollback arrives
    const container = containerRefs.current.get(id)
    if (container) tm.ensureTerminal(id, container)
    const dims = tm.getDimensions(id)
    send({ type: 'attach', id, ...dims })
  }

  function killSession(id: string) {
    send({ type: 'kill', id })
    setKillTarget(null)
  }

  function renameSession(id: string, name: string) {
    setSessions(s => s.map(s => s.id === id ? { ...s, name } : s))
    send({ type: 'rename', id, name })
  }

  return (
    <div className="app">
      <header className="header">
        <div className="wordmark">web<span>—</span>terminal</div>
      </header>

      <Sidebar
        sessions={sessions}
        currentId={currentId}
        status={status}
        onNew={newSession}
        onAttach={attachSession}
        onKill={(id) => setKillTarget(sessions.find(s => s.id === id) ?? null)}
        onRename={renameSession}
      />

      <main className="main">
        {!currentId && (
          <div className="no-session">
            <div className="no-session-prompt">no active session</div>
            <button className="no-session-btn" onClick={newSession}>new session</button>
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
