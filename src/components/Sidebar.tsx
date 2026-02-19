import { useRef, useState } from 'react'
import type { Session, ConnectionStatus } from '../types'

interface Props {
  sessions: Session[]
  currentId: string | null
  status: ConnectionStatus
  onNew: () => void
  onAttach: (id: string) => void
  onKill: (id: string) => void
  onRename: (id: string, name: string) => void
}

export function Sidebar({ sessions, currentId, status, onNew, onAttach, onKill, onRename }: Props) {
  return (
    <nav className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-meta">
          <span className="sidebar-label">Sessions</span>
          <div className="status">
            <div className={`status-dot ${status}`} />
            <span className="status-text">{status}</span>
          </div>
        </div>
        <button className="new-btn" onClick={onNew} title="New session (Alt+T)">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          new
        </button>
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="empty-state">
            no sessions yet<br />
            <kbd>Alt+T</kbd> or click <kbd>+ new</kbd>
          </div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === currentId}
              onAttach={() => onAttach(s.id)}
              onKill={() => onKill(s.id)}
              onRename={(name) => onRename(s.id, name)}
            />
          ))
        )}
      </div>
    </nav>
  )
}

function SessionItem({
  session,
  active,
  onAttach,
  onKill,
  onRename,
}: {
  session: Session
  active: boolean
  onAttach: () => void
  onKill: () => void
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setDraft(session.name)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function commitEdit() {
    setEditing(false)
    const name = draft.trim() || session.name
    setDraft(name)
    if (name !== session.name) onRename(name)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    if (e.key === 'Escape') { setDraft(session.name); setEditing(false) }
  }

  return (
    <div className={`session-item ${active ? 'active' : ''}`} onClick={onAttach}>
      <div className="session-indicator" />

      {editing ? (
        <input
          ref={inputRef}
          className="session-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
          autoFocus
        />
      ) : (
        <div className="session-label">
          <span className="session-name" onDoubleClick={startEdit} title="double-click to rename">
            {session.name}
          </span>
          {session.cwd && (
            <span className="session-cwd" title={session.cwd}>
              {session.cwd.split('/').filter(Boolean).pop() ?? '/'}
            </span>
          )}
        </div>
      )}

      {session.clients > 1 && <span className="session-clients">{session.clients}</span>}

      <button
        className="kill-btn"
        onClick={(e) => { e.stopPropagation(); onKill() }}
        title="Kill session"
      >
        ✕
      </button>
    </div>
  )
}
