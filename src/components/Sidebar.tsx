import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { MutableRefObject } from 'react'
import { ContextMenu } from './ContextMenu'
import type { ConnectionStatus, Host, Session, SessionKey } from '../types'
import { makeKey, parseKey } from '../types'

interface Props {
  hosts: Host[]
  hostSessions: Map<string, Session[]>
  hostStatuses: Map<string, ConnectionStatus>
  currentKey: SessionKey | null
  isOpen: boolean
  onNew: (hostId: string) => void
  onAttach: (key: SessionKey) => void
  onKill: (key: SessionKey) => void
  onRename: (key: SessionKey, name: string) => void
  onDuplicate: (key: SessionKey) => void
  onReorder: (fromKey: SessionKey, toKey: SessionKey) => void
  onReorderToEnd: (fromKey: SessionKey, hostId: string) => void
}

interface CtxMenu { key: SessionKey; x: number; y: number }

function supportsPointerDragReorder(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  // Touch dragging on draggable session rows interferes with native sidebar
  // scrolling on mobile; keep drag reorder for mouse/trackpad devices.
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

export function Sidebar({
  hosts,
  hostSessions,
  hostStatuses,
  currentKey,
  isOpen,
  onNew,
  onAttach,
  onKill,
  onRename,
  onDuplicate,
  onReorder,
  onReorderToEnd,
}: Props) {
  const [editingKey, setEditingKey] = useState<SessionKey | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [dragOverKey, setDragOverKey] = useState<SessionKey | null>(null)
  const [dragOverEndHost, setDragOverEndHost] = useState<string | null>(null)
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set())
  const draggedKeyRef = useRef<SessionKey | null>(null)
  const singleHost = hosts.length <= 1

  useEffect(() => {
    setCollapsedHosts(prev => {
      if (prev.size === 0) return prev
      const activeIds = new Set(hosts.map(h => h.id))
      const next = new Set<string>()
      for (const id of prev) if (activeIds.has(id)) next.add(id)
      return next
    })
  }, [hosts])

  function toggleHost(hostId: string) {
    setCollapsedHosts(prev => {
      const next = new Set(prev)
      if (next.has(hostId)) next.delete(hostId)
      else next.add(hostId)
      return next
    })
  }

  const localHost = hosts.find(h => h.local) ?? hosts[0]
  const singleHostId = localHost?.id ?? ''
  const singleSessions = singleHostId ? (hostSessions.get(singleHostId) ?? []) : []
  const singleStatus: ConnectionStatus = hostStatuses.get(singleHostId) ?? 'reconnecting'

  return (
    <nav className={`sidebar${isOpen ? ' open' : ''}`}>
      {singleHost ? (
        <>
          <div className="sidebar-top">
            <div className="sidebar-meta">
              <span className="sidebar-label">Sessions</span>
              <div className="status">
                <div className={`status-dot ${singleStatus}`} />
                <span className="status-text">{singleStatus}</span>
              </div>
            </div>
            <button className="new-btn" onClick={() => onNew(singleHostId)} title="New session (Alt+T)">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              new
            </button>
          </div>

          <HostSessionList
            hostId={singleHostId}
            sessions={singleSessions}
            currentKey={currentKey}
            editingKey={editingKey}
            dragOverKey={dragOverKey}
            dragOverEndHost={dragOverEndHost}
            disabled={singleStatus !== 'connected'}
            onAttach={onAttach}
            onKill={onKill}
            onRename={onRename}
            onDuplicate={onDuplicate}
            onStartEdit={setEditingKey}
            onContextMenu={setCtxMenu}
            onDragOverKey={setDragOverKey}
            onDragOverEndHost={setDragOverEndHost}
            draggedKeyRef={draggedKeyRef}
            onReorder={onReorder}
            onReorderToEnd={onReorderToEnd}
            onClearDrag={() => { draggedKeyRef.current = null; setDragOverKey(null); setDragOverEndHost(null) }}
          />
        </>
      ) : (
        <div className="host-groups">
          {hosts.map(host => {
            const status: ConnectionStatus = hostStatuses.get(host.id) ?? 'reconnecting'
            const isCollapsed = collapsedHosts.has(host.id)
            const isOffline = status !== 'connected'
            const sessions = hostSessions.get(host.id) ?? []
            return (
              <section key={host.id} className={`host-group${isOffline ? ' host-header--offline' : ''}`}>
                <button className="host-header" onClick={() => toggleHost(host.id)}>
                  <span className="host-header-name">{host.name}</span>
                  <span className="status">
                    <span className={`status-dot ${status}`} />
                    <span className="status-text">{status}</span>
                  </span>
                </button>
                <div className="host-group-actions">
                  <button className="new-btn" onClick={() => onNew(host.id)} disabled={isOffline}>
                    new
                  </button>
                </div>
                {!isCollapsed && (
                  <HostSessionList
                    hostId={host.id}
                    sessions={sessions}
                    currentKey={currentKey}
                    editingKey={editingKey}
                    dragOverKey={dragOverKey}
                    dragOverEndHost={dragOverEndHost}
                    disabled={isOffline}
                    onAttach={onAttach}
                    onKill={onKill}
                    onRename={onRename}
                    onDuplicate={onDuplicate}
                    onStartEdit={setEditingKey}
                    onContextMenu={setCtxMenu}
                    onDragOverKey={setDragOverKey}
                    onDragOverEndHost={setDragOverEndHost}
                    draggedKeyRef={draggedKeyRef}
                    onReorder={onReorder}
                    onReorderToEnd={onReorderToEnd}
                    onClearDrag={() => { draggedKeyRef.current = null; setDragOverKey(null); setDragOverEndHost(null) }}
                  />
                )}
              </section>
            )
          })}
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: 'Rename',
              onClick: () => { setEditingKey(ctxMenu.key); setCtxMenu(null) },
            },
            {
              label: 'Duplicate',
              onClick: () => { onDuplicate(ctxMenu.key); setCtxMenu(null) },
            },
            {
              label: 'Kill',
              danger: true,
              onClick: () => { onKill(ctxMenu.key); setCtxMenu(null) },
            },
          ]}
        />
      )}
    </nav>
  )
}

interface HostSessionListProps {
  hostId: string
  sessions: Session[]
  currentKey: SessionKey | null
  editingKey: SessionKey | null
  dragOverKey: SessionKey | null
  dragOverEndHost: string | null
  disabled: boolean
  onAttach: (key: SessionKey) => void
  onKill: (key: SessionKey) => void
  onRename: (key: SessionKey, name: string) => void
  onDuplicate: (key: SessionKey) => void
  onStartEdit: (key: SessionKey | null) => void
  onContextMenu: (ctx: CtxMenu | null) => void
  onDragOverKey: (key: SessionKey | null) => void
  onDragOverEndHost: (hostId: string | null) => void
  draggedKeyRef: MutableRefObject<SessionKey | null>
  onReorder: (fromKey: SessionKey, toKey: SessionKey) => void
  onReorderToEnd: (fromKey: SessionKey, hostId: string) => void
  onClearDrag: () => void
}

function HostSessionList({
  hostId,
  sessions,
  currentKey,
  editingKey,
  dragOverKey,
  dragOverEndHost,
  disabled,
  onAttach,
  onKill,
  onRename,
  onDuplicate,
  onStartEdit,
  onContextMenu,
  onDragOverKey,
  onDragOverEndHost,
  draggedKeyRef,
  onReorder,
  onReorderToEnd,
  onClearDrag,
}: HostSessionListProps) {
  return (
    <div className="session-list">
      {sessions.length === 0 ? (
        <div className="empty-state">no sessions</div>
      ) : (
        <>
          {sessions.map((s) => {
            const key = makeKey(hostId, s.id)
            return (
              <SessionItem
                key={key}
                data-session-id={s.id}
                session={s}
                active={currentKey === key}
                disabled={disabled}
                isEditing={editingKey === key}
                isDragOver={dragOverKey === key}
                onAttach={() => { if (!disabled) onAttach(key) }}
                onKill={() => { if (!disabled) onKill(key) }}
                onStartEdit={() => { if (!disabled) onStartEdit(key) }}
                onCommitEdit={(name) => { onStartEdit(null); if (!disabled && name !== s.name) onRename(key, name) }}
                onCancelEdit={() => onStartEdit(null)}
                onContextMenu={(e) => { if (!disabled) { e.preventDefault(); onContextMenu({ key, x: e.clientX, y: e.clientY }) } }}
                onLongPress={(x, y) => { if (!disabled) onContextMenu({ key, x, y }) }}
                onDragStart={() => { if (!disabled) draggedKeyRef.current = key }}
                onDragOver={(e) => {
                  if (disabled || !draggedKeyRef.current || parseKey(draggedKeyRef.current).hostId !== hostId || draggedKeyRef.current === key) return
                  e.preventDefault()
                  onDragOverKey(key)
                }}
                onDragLeave={() => onDragOverKey(null)}
                onDrop={() => {
                  if (disabled || !draggedKeyRef.current || parseKey(draggedKeyRef.current).hostId !== hostId || draggedKeyRef.current === key) {
                    onClearDrag()
                    return
                  }
                  onReorder(draggedKeyRef.current, key)
                  onClearDrag()
                }}
                onDragEnd={onClearDrag}
              />
            )
          })}
          <div
            className={`session-drop-end${dragOverEndHost === hostId ? ' drag-over' : ''}`}
            onDragOver={(e) => {
              if (disabled || !draggedKeyRef.current || parseKey(draggedKeyRef.current).hostId !== hostId) return
              e.preventDefault()
              onDragOverEndHost(hostId)
            }}
            onDragLeave={() => onDragOverEndHost(null)}
            onDrop={() => {
              if (disabled || !draggedKeyRef.current || parseKey(draggedKeyRef.current).hostId !== hostId) {
                onClearDrag()
                return
              }
              onReorderToEnd(draggedKeyRef.current, hostId)
              onClearDrag()
            }}
          />
        </>
      )}
    </div>
  )
}

interface ItemProps {
  session: Session
  active: boolean
  disabled: boolean
  isEditing: boolean
  isDragOver: boolean
  'data-session-id': string
  onAttach: () => void
  onKill: () => void
  onStartEdit: () => void
  onCommitEdit: (name: string) => void
  onCancelEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onLongPress: (x: number, y: number) => void
  onDragStart: () => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
  onDrop: () => void
  onDragEnd: () => void
}

function SessionItem({ session, active, disabled, isEditing, isDragOver, 'data-session-id': dataSessionId, onAttach, onKill, onStartEdit, onCommitEdit, onCancelEdit, onContextMenu, onLongPress, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd }: ItemProps) {
  const [draft, setDraft] = useState(session.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)
  const canDragReorder = supportsPointerDragReorder()

  function startLongPress(e: React.PointerEvent) {
    longPressFiredRef.current = false
    if (disabled) return
    if (e.button !== 0 && e.pointerType !== 'touch') return
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null
      longPressFiredRef.current = true
      onLongPress(e.clientX, e.clientY)
    }, 500)
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

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
      className={`session-item ${active ? 'active' : ''} ${isDragOver ? 'drag-over' : ''} ${disabled ? 'disabled' : ''}`}
      data-session-id={dataSessionId}
      draggable={!isEditing && !disabled && canDragReorder}
      onClick={() => {
        if (longPressFiredRef.current) { longPressFiredRef.current = false; return }
        if (!disabled) onAttach()
      }}
      onContextMenu={onContextMenu}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerMove={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="session-indicator" />

      <div className="session-label">
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
          <span className="session-name" onDoubleClick={(e) => { e.stopPropagation(); if (!disabled) onStartEdit() }}>
            {session.name}
          </span>
        )}
        {session.cwd && (
          <span className="session-cwd" title={session.cwd}>
            {session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '/'}
          </span>
        )}
      </div>

      <button
        className="kill-btn"
        onClick={(e) => { e.stopPropagation(); if (!disabled) onKill() }}
        title="Kill session"
      >
        ✕
      </button>
    </div>
  )
}
