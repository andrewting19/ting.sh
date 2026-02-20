import { useEffect, useRef, useState } from 'react'
import { ContextMenu } from './ContextMenu'
import type { Session, ConnectionStatus } from '../types'

interface Props {
  sessions: Session[]
  currentId: string | null
  status: ConnectionStatus
  onNew: () => void
  onAttach: (id: string) => void
  onKill: (id: string) => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
}

interface CtxMenu { id: string; x: number; y: number }

export function Sidebar({ sessions, currentId, status, onNew, onAttach, onKill, onRename, onDuplicate }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)

  function openContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault()
    setCtxMenu({ id, x: e.clientX, y: e.clientY })
  }

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
              isEditing={editingId === s.id}
              onAttach={() => onAttach(s.id)}
              onKill={() => onKill(s.id)}
              onStartEdit={() => setEditingId(s.id)}
              onCommitEdit={(name) => { setEditingId(null); if (name !== s.name) onRename(s.id, name) }}
              onCancelEdit={() => setEditingId(null)}
              onContextMenu={(e) => openContextMenu(e, s.id)}
            />
          ))
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: 'Rename',
              onClick: () => { setEditingId(ctxMenu.id); setCtxMenu(null) },
            },
            {
              label: 'Duplicate',
              onClick: () => { onDuplicate(ctxMenu.id); setCtxMenu(null) },
            },
            {
              label: 'Kill',
              danger: true,
              onClick: () => { onKill(ctxMenu.id); setCtxMenu(null) },
            },
          ]}
        />
      )}
    </nav>
  )
}

interface ItemProps {
  session: Session
  active: boolean
  isEditing: boolean
  onAttach: () => void
  onKill: () => void
  onStartEdit: () => void
  onCommitEdit: (name: string) => void
  onCancelEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function SessionItem({ session, active, isEditing, onAttach, onKill, onStartEdit, onCommitEdit, onCancelEdit, onContextMenu }: ItemProps) {
  const [draft, setDraft] = useState(session.name)
  const inputRef = useRef<HTMLInputElement>(null)

  // When editing starts (triggered externally), reset draft and focus
  useEffect(() => {
    if (isEditing) {
      setDraft(session.name)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [isEditing]) // eslint-disable-line react-hooks/exhaustive-deps

  function commit() {
    onCommitEdit(draft.trim() || session.name)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    if (e.key === 'Escape') { onCancelEdit() }
  }

  return (
    <div
      className={`session-item ${active ? 'active' : ''}`}
      onClick={onAttach}
      onContextMenu={onContextMenu}
    >
      <div className="session-indicator" />

      {isEditing ? (
        <input
          ref={inputRef}
          className="session-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
          autoFocus
        />
      ) : (
        <div className="session-label">
          <span className="session-name" onDoubleClick={(e) => { e.stopPropagation(); onStartEdit() }}>
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
