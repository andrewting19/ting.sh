import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { Modal } from './components/Modal'
import { MobileToolbar } from './components/MobileToolbar'
import { SelectionModal } from './components/SelectionModal'
import { getArrowSequence, type ArrowDirection } from './components/ArrowPad'
import { useHostConnections } from './hooks/useHostConnections'
import { useTerminalManager } from './hooks/useTerminalManager'
import { persistTerminalRenderer, resolveTerminalRenderer } from './terminal/renderer'
import type { TerminalRenderer } from './terminal/backends'
import type { ConnectionStatus, Host, Session, SessionKey, SidecarStatus } from './types'
import { makeKey, parseKey } from './types'
import type { TerminalSnapshot } from './snapshot/types'
import './App.css'

const LEGACY_LOCAL_HOST_ID = 'local'
type PendingRequest = { hostId: string; requestId: string; kind: 'attach' | 'create' }
type PendingSnapshotAttach = {
  key: SessionKey
  hostId: string
  sessionId: string
  sessionName: string
  requestId: string
  cutSeq: number
}
type AttachMode = 'raw' | 'snapshot'
type SessionOrderByHost = Record<string, string[]>
type AttachReplayMetric = {
  key: SessionKey
  hostId: string
  sessionId: string
  sessionName: string
  requestId: string
  requestedAt: number
  readyAt: number | null
  firstByteAt: number | null
  replayReceivedAt: number | null
  firstWriteFlushAt: number | null
  replayBytesExpected: number | null
  replayLineBreaks: number | null
  replayTrimmed: boolean
  replayBytesReceived: number
  replayChunkCount: number
  attachMode: AttachMode
  snapshotBackend: string | null
}

const LEGACY_SESSION_ORDER_KEY = 'wt-session-order'
const SESSION_ORDER_STORAGE_PREFIX = 'wt-session-order:'

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const next: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    next.push(item)
  }
  return next
}

function readHostSessionOrder(hostId: string, isLocalHost = false): string[] {
  try {
    const raw = localStorage.getItem(`${SESSION_ORDER_STORAGE_PREFIX}${hostId}`)
    if (raw) return toStringArray(JSON.parse(raw))

    if (!isLocalHost && hostId !== LEGACY_LOCAL_HOST_ID) return []
    const legacyRaw = localStorage.getItem(LEGACY_SESSION_ORDER_KEY)
    if (!legacyRaw) return []
    const legacy = toStringArray(JSON.parse(legacyRaw))
    const next: string[] = []
    const seen = new Set<string>()
    for (const item of legacy) {
      const sep = item.indexOf(':')
      const sessionId = sep === -1 ? item : item.slice(sep + 1)
      if (sessionId.length === 0 || seen.has(sessionId)) continue
      seen.add(sessionId)
      next.push(sessionId)
    }
    return next
  } catch {
    return []
  }
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function remapSessionKeyHost(key: SessionKey | null, fromHostId: string, toHostId: string): SessionKey | null {
  if (!key || fromHostId === toHostId) return key
  const { hostId, sessionId } = parseKey(key)
  if (hostId !== fromHostId) return key
  return makeKey(toHostId, sessionId)
}

function normalizeHostId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const id = value.trim()
  if (!id || id.includes(':')) return fallback
  return id
}

function normalizeHostName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim()
  return name || fallback
}

function getMobileKeyboardInset(): number {
  if (typeof window === 'undefined') return 0
  if (!window.matchMedia('(max-width: 640px)').matches) return 0
  const vv = window.visualViewport
  if (!vv) return 0
  // Layout viewport minus visible viewport = obscured bottom inset (keyboard on iOS).
  const raw = Math.round(window.innerHeight - vv.height - vv.offsetTop)
  if (raw <= 0) return 0
  // Ignore small browser-chrome / viewport jitter changes.
  return raw >= 80 ? raw : 0
}

function shouldAutoFocusTerminalOnSessionSelect(): boolean {
  if (typeof window === 'undefined') return true
  return !window.matchMedia('(max-width: 640px)').matches
}

function shouldIgnoreGlobalTerminalShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.terminal-pane')) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

const MOBILE_KEYBOARD_RESIZE_SETTLE_MS = 120
const TERMINAL_RESIZE_SETTLE_MS = 150
const SNAPSHOT_ATTACH_ENABLED = import.meta.env.VITE_SNAPSHOT_ATTACH !== 'false'

function decodeBase64Utf8(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function App() {
  const [terminalRenderer] = useState<TerminalRenderer>(() => resolveTerminalRenderer())
  const [switchingRenderer, setSwitchingRenderer] = useState<TerminalRenderer | null>(null)
  const [mobileKeyboardInset, setMobileKeyboardInset] = useState(0)
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null)
  const [studyCopyState, setStudyCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [restartSidecarModalOpen, setRestartSidecarModalOpen] = useState(false)
  const [restartingSidecar, setRestartingSidecar] = useState(false)
  const [backgroundPeerConnectionsReady, setBackgroundPeerConnectionsReady] = useState(false)
  const [hosts, setHosts] = useState<Host[]>([{ id: LEGACY_LOCAL_HOST_ID, name: 'Local Host', url: location.origin, local: true }])
  const [hostSessions, setHostSessions] = useState<Map<string, Session[]>>(new Map())
  const [currentKey, setCurrentKey] = useState<SessionKey | null>(null)
  const [killTargetKey, setKillTargetKey] = useState<SessionKey | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const localHostId = hosts.find(h => h.local)?.id ?? LEGACY_LOCAL_HOST_ID
  const currentHostId = currentKey ? parseKey(currentKey).hostId : localHostId
  const sessions = hostSessions.get(currentHostId) ?? []
  const currentId = currentKey ? parseKey(currentKey).sessionId : null

  // Sync refs for use inside callbacks (avoid stale closures)
  const currentKeyRef = useRef<SessionKey | null>(null)
  const hostSessionsRef = useRef<Map<string, Session[]>>(new Map())
  const sessionOrderByHostRef = useRef<SessionOrderByHost>({})
  currentKeyRef.current = currentKey
  hostSessionsRef.current = hostSessions
  // sessionOrderByHostRef.current is assigned after sessionOrderByHost useState below

  // Session currently attached on the server for this WS connection.
  // Binary output always routes here (never to optimistic UI state).
  const attachedKeyRef = useRef<SessionKey | null>(null)
  // Latest in-flight attach request. Older ready responses are ignored.
  const pendingRequestRef = useRef<PendingRequest | null>(null)
  const pendingAttachTargetKeyRef = useRef<SessionKey | null>(null)
  const pendingSnapshotAttachRef = useRef<PendingSnapshotAttach | null>(null)
  const queuedAttachKeyRef = useRef<SessionKey | null>(null)
  const nextRequestSeqRef = useRef(0)
  // When we ignore a stale attach ready, drop binary until the newest attach
  // is confirmed so replay from the stale attach cannot contaminate terminals.
  const dropBinaryUntilReadyRef = useRef(false)
  // Attach/reset replays can leave xterm's viewport at an arbitrary position
  // (notably top after reconnect/hot-reload). Keep a pending "jump to latest"
  // marker for attach requests and clear it once the first replay/output frame
  // has flushed and we've had a chance to settle resize/fit work.
  const scrollToBottomAfterAttachBinaryRef = useRef<SessionKey | null>(null)
  const pendingTerminalResizeRef = useRef<{ key: SessionKey; cols: number; rows: number } | null>(null)
  const terminalResizeTimeoutRef = useRef<number | null>(null)
  const lastSentResizeByKeyRef = useRef<Map<SessionKey, string>>(new Map())
  const attachMetricsByRequestIdRef = useRef<Map<string, AttachReplayMetric>>(new Map())
  const latestAttachMetricByKeyRef = useRef<Map<SessionKey, AttachReplayMetric>>(new Map())
  const attachSessionRef = useRef<(key: SessionKey) => void>(() => {})

  // When set, the next ready response is a duplicate — insert after this ID
  const duplicateSourceKeyRef = useRef<SessionKey | null>(null)

  // Track sessions killed this WS connection to avoid attaching to dead ones
  // during cascading kills (e.g. killAllSessions sends bulk kill messages)
  const killedSessionKeys = useRef<Set<SessionKey>>(new Set())

  // URL hash routing: only do the initial hash navigation once, after the
  // first non-empty sessions list arrives from the server.
  const hasHandledInitialHashRef = useRef(false)

  // Client-side session order (persisted to localStorage for drag-and-drop etc.)
  const [sessionOrderByHost, setSessionOrderByHost] = useState<SessionOrderByHost>(() => ({
    [LEGACY_LOCAL_HOST_ID]: readHostSessionOrder(LEGACY_LOCAL_HOST_ID, true),
  }))
  sessionOrderByHostRef.current = sessionOrderByHost
  const [showScrollToBottomByKey, setShowScrollToBottomByKey] = useState<Record<string, boolean>>({})
  const [textSelectionOpen, setTextSelectionOpen] = useState(false)
  const [textSelectionSnapshot, setTextSelectionSnapshot] = useState('')

  useEffect(() => {
    for (const [hostId, order] of Object.entries(sessionOrderByHost)) {
      localStorage.setItem(`${SESSION_ORDER_STORAGE_PREFIX}${hostId}`, JSON.stringify(order))
    }
    const localOrder = sessionOrderByHost[localHostId]
    if (localOrder) {
      // Keep legacy keys hot so reloads that start before host-id reconciliation
      // still restore the local host ordering.
      localStorage.setItem(`${SESSION_ORDER_STORAGE_PREFIX}${LEGACY_LOCAL_HOST_ID}`, JSON.stringify(localOrder))
      localStorage.setItem(LEGACY_SESSION_ORDER_KEY, JSON.stringify(localOrder))
    }
  }, [localHostId, sessionOrderByHost])

  useEffect(() => {
    setSessionOrderByHost(prev => {
      let changed = false
      const next = { ...prev }
      for (const host of hosts) {
        if (Object.prototype.hasOwnProperty.call(next, host.id)) continue
        next[host.id] = readHostSessionOrder(host.id, host.local)
        changed = true
      }
      return changed ? next : prev
    })
  }, [hosts])

  const parseHashRoute = useCallback((hash: string): { hostId: string; target: string } | null => {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash
    if (!raw) return null

    const slashIdx = raw.indexOf('/')
    if (slashIdx === -1) {
      try {
        return { hostId: localHostId, target: decodeURIComponent(raw) }
      } catch {
        return null
      }
    }

    const rawHost = raw.slice(0, slashIdx)
    const rawTarget = raw.slice(slashIdx + 1)
    try {
      const decodedHostId = decodeURIComponent(rawHost)
      const hostId = decodedHostId === LEGACY_LOCAL_HOST_ID ? localHostId : decodedHostId
      const target = decodeURIComponent(rawTarget)
      if (!hostId || !target) return null
      return { hostId, target }
    } catch {
      return null
    }
  }, [localHostId])

  const replaceHash = useCallback((hostId: string, name: string) => {
    history.replaceState(null, '', `#${encodeURIComponent(hostId)}/${encodeURIComponent(name)}`)
  }, [])

  // Merge server session list into local host order:
  // keep existing order, drop dead sessions, append new ones at end.
  // Skip untouched hosts so we don't wipe localStorage-restored order before
  // the first sessions list arrives for that host.
  useEffect(() => {
    setSessionOrderByHost(prev => {
      let changed = false
      const next = { ...prev }
      for (const [hostId, list] of hostSessions.entries()) {
        const ids = list.map(s => s.id)
        const idSet = new Set(ids)
        const current = next[hostId] ?? []
        const kept = current.filter(id => idSet.has(id))
        const keptSet = new Set(kept)
        const added = ids.filter(id => !keptSet.has(id))
        const merged = [...kept, ...added]
        if (!sameStringArray(current, merged)) {
          next[hostId] = merged
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [hostSessions])

  const orderedHostSessions = useMemo(() => {
    const next = new Map<string, Session[]>()
    for (const host of hosts) {
      const list = hostSessions.get(host.id) ?? []
      const order = sessionOrderByHost[host.id] ?? []
      next.set(host.id, [...list].sort((a, b) => {
        const ai = order.indexOf(a.id)
        const bi = order.indexOf(b.id)
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
      }))
    }
    return next
  }, [hostSessions, hosts, sessionOrderByHost])

  // Per-session container refs — one div per session, always in DOM
  const containerRefs = useRef<Map<SessionKey, HTMLDivElement>>(new Map())

  const getSessionByKey = useCallback((key: SessionKey): Session | null => {
    const { hostId, sessionId } = parseKey(key)
    return hostSessionsRef.current.get(hostId)?.find(s => s.id === sessionId) ?? null
  }, [])

  const updateAttachMetric = useCallback((metric: AttachReplayMetric) => {
    latestAttachMetricByKeyRef.current.set(metric.key, { ...metric })
    attachMetricsByRequestIdRef.current.set(metric.requestId, { ...metric })
  }, [])

  function forwardTerminalBinary(key: SessionKey, data: Uint8Array) {
    const now = performance.now()
    const metric = latestAttachMetricByKeyRef.current.get(key)
    if (metric && metric.readyAt !== null && metric.replayReceivedAt === null) {
      const next = { ...metric }
      if (next.firstByteAt === null) next.firstByteAt = now
      if (typeof next.replayBytesExpected === 'number') {
        const remaining = Math.max(0, next.replayBytesExpected - next.replayBytesReceived)
        const consumed = Math.min(remaining, data.length)
        if (consumed > 0) {
          next.replayBytesReceived += consumed
          next.replayChunkCount += 1
        }
        if (next.replayBytesReceived >= next.replayBytesExpected) {
          next.replayReceivedAt = now
        }
      }
      updateAttachMetric(next)
    }
    const shouldScrollToBottom = scrollToBottomAfterAttachBinaryRef.current === key
    tm.write(key, data, shouldScrollToBottom
      ? () => handleAttachWriteFlushed(key)
      : () => {
          const currentMetric = latestAttachMetricByKeyRef.current.get(key)
          if (currentMetric && currentMetric.firstWriteFlushAt === null) {
            updateAttachMetric({ ...currentMetric, firstWriteFlushAt: performance.now() })
          }
        })
  }

  const { hostStatuses, connect, disconnect, send: sendToHost, forceClose } = useHostConnections({
    onBinary: (hostId, data) => {
      if (dropBinaryUntilReadyRef.current) return
      const key = attachedKeyRef.current
      if (!key) return
      if (parseKey(key).hostId !== hostId) return
      forwardTerminalBinary(key, new Uint8Array(data))
    },
    onMessage: (hostId, msg) => handleMessage(hostId, msg),
  })

  const sendTerminalResize = useCallback((key: SessionKey, cols: number, rows: number, force = false) => {
    const nextSize = `${cols}x${rows}`
    if (!force && lastSentResizeByKeyRef.current.get(key) === nextSize) return
    lastSentResizeByKeyRef.current.set(key, nextSize)
    sendToHost(parseKey(key).hostId, { type: 'resize', cols, rows })
  }, [sendToHost])

  const flushPendingTerminalResize = useCallback((force = false) => {
    if (terminalResizeTimeoutRef.current !== null) {
      window.clearTimeout(terminalResizeTimeoutRef.current)
      terminalResizeTimeoutRef.current = null
    }
    const pending = pendingTerminalResizeRef.current
    pendingTerminalResizeRef.current = null
    if (!pending) return
    if (pending.key !== currentKeyRef.current) return
    sendTerminalResize(pending.key, pending.cols, pending.rows, force)
  }, [sendTerminalResize])

  const scheduleTerminalResize = useCallback((key: SessionKey, cols: number, rows: number) => {
    pendingTerminalResizeRef.current = { key, cols, rows }
    if (terminalResizeTimeoutRef.current !== null) {
      window.clearTimeout(terminalResizeTimeoutRef.current)
    }
    terminalResizeTimeoutRef.current = window.setTimeout(() => {
      terminalResizeTimeoutRef.current = null
      const pending = pendingTerminalResizeRef.current
      pendingTerminalResizeRef.current = null
      if (!pending) return
      if (pending.key !== currentKeyRef.current) return
      sendTerminalResize(pending.key, pending.cols, pending.rows)
    }, TERMINAL_RESIZE_SETTLE_MS)
  }, [sendTerminalResize])

  const tm = useTerminalManager({
    onData: (sessionKey, data) => {
      if (sessionKey !== currentKeyRef.current) return
      sendToHost(parseKey(sessionKey).hostId, { type: 'input', data })
    },
    onResize: (sessionKey, cols, rows) => {
      if (sessionKey !== currentKeyRef.current) return
      scheduleTerminalResize(sessionKey, cols, rows)
    },
    onScrollStateChange: (sessionKey, showScrollToBottom) => {
      setShowScrollToBottomByKey(prev => {
        const current = !!prev[sessionKey]
        if (current === showScrollToBottom) return prev
        if (!showScrollToBottom) {
          const next = { ...prev }
          delete next[sessionKey]
          return next
        }
        return { ...prev, [sessionKey]: true }
      })
    },
  }, { backendId: terminalRenderer })

  function handleAttachWriteFlushed(key: SessionKey) {
    const currentMetric = latestAttachMetricByKeyRef.current.get(key)
    if (currentMetric && currentMetric.firstWriteFlushAt === null) {
      updateAttachMetric({ ...currentMetric, firstWriteFlushAt: performance.now() })
    }
    if (scrollToBottomAfterAttachBinaryRef.current !== key) return
    scrollToBottomAfterAttachBinaryRef.current = null
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (currentKeyRef.current !== key) return
        tm.scrollToBottom(key)
      })
    })
  }

  useEffect(() => {
    return () => {
      if (terminalResizeTimeoutRef.current !== null) {
        window.clearTimeout(terminalResizeTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.terminalRenderer = terminalRenderer
    return () => {
      delete document.documentElement.dataset.terminalRenderer
    }
  }, [terminalRenderer])

  const reconcileLocalHostIdentity = useCallback((connectionHostId: string, reportedId: string, reportedName: string) => {
    const localConnection = hosts.find(host => host.local && host.id === connectionHostId)
    const currentName = hosts.find(host => host.id === connectionHostId)?.name ?? 'Local Host'
    const normalizedName = normalizeHostName(reportedName, currentName)
    if (!localConnection) {
      setHosts(prev => prev.map(host => host.id === connectionHostId ? { ...host, name: normalizedName } : host))
      return
    }

    const normalizedId = normalizeHostId(reportedId, connectionHostId)
    const collides = normalizedId !== connectionHostId && hosts.some(host => host.id === normalizedId && host.id !== connectionHostId)
    const nextLocalId = collides ? connectionHostId : normalizedId

    setHosts(prev => prev.map(host => {
      if (!(host.local && host.id === connectionHostId)) return host
      return { ...host, id: nextLocalId, name: normalizedName }
    }))

    if (nextLocalId === connectionHostId) return

    const migratedSessions = hostSessionsRef.current.get(connectionHostId) ?? []
    for (const session of migratedSessions) {
      const oldKey = makeKey(connectionHostId, session.id)
      tm.destroy(oldKey)
      containerRefs.current.delete(oldKey)
    }

    setHostSessions(prev => {
      const moved = prev.get(connectionHostId)
      if (!moved) return prev
      const next = new Map(prev)
      next.delete(connectionHostId)
      const existing = next.get(nextLocalId) ?? []
      const byId = new Map<string, Session>()
      for (const session of existing) byId.set(session.id, session)
      for (const session of moved) byId.set(session.id, { ...session, hostId: nextLocalId })
      next.set(nextLocalId, [...byId.values()])
      return next
    })

    setSessionOrderByHost(prev => {
      const moved = prev[connectionHostId]
      if (!moved) return prev
      const existing = prev[nextLocalId] ?? []
      const merged = [...moved, ...existing.filter(id => !moved.includes(id))]
      const next: SessionOrderByHost = { ...prev, [nextLocalId]: merged }
      delete next[connectionHostId]
      return next
    })
    setShowScrollToBottomByKey(prev => {
      let changed = false
      const next: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(prev)) {
        const mapped = remapSessionKeyHost(key, connectionHostId, nextLocalId) ?? key
        next[mapped] = value
        if (mapped !== key) changed = true
      }
      return changed ? next : prev
    })

    currentKeyRef.current = remapSessionKeyHost(currentKeyRef.current, connectionHostId, nextLocalId)
    attachedKeyRef.current = remapSessionKeyHost(attachedKeyRef.current, connectionHostId, nextLocalId)
    pendingAttachTargetKeyRef.current = remapSessionKeyHost(pendingAttachTargetKeyRef.current, connectionHostId, nextLocalId)
    if (pendingSnapshotAttachRef.current) {
      const mappedKey = remapSessionKeyHost(pendingSnapshotAttachRef.current.key, connectionHostId, nextLocalId)
      pendingSnapshotAttachRef.current = mappedKey ? {
        ...pendingSnapshotAttachRef.current,
        key: mappedKey,
        hostId: parseKey(mappedKey).hostId,
      } : null
    }
    duplicateSourceKeyRef.current = remapSessionKeyHost(duplicateSourceKeyRef.current, connectionHostId, nextLocalId)
    setCurrentKey(prev => remapSessionKeyHost(prev, connectionHostId, nextLocalId))
    setKillTargetKey(prev => remapSessionKeyHost(prev, connectionHostId, nextLocalId))

    const remappedKilled = new Set<SessionKey>()
    for (const key of killedSessionKeys.current) {
      const mapped = remapSessionKeyHost(key, connectionHostId, nextLocalId)
      if (mapped) remappedKilled.add(mapped)
    }
    killedSessionKeys.current = remappedKilled

    if (pendingRequestRef.current?.hostId === connectionHostId) {
      pendingRequestRef.current = { ...pendingRequestRef.current, hostId: nextLocalId }
    }
  }, [hosts, tm])

  const sendAttachRequest = useCallback((key: SessionKey, dims: { cols: number; rows: number }, mode: AttachMode = 'snapshot') => {
    const requestId = `attach-${++nextRequestSeqRef.current}`
    const { hostId, sessionId } = parseKey(key)
    const metric: AttachReplayMetric = {
      key,
      hostId,
      sessionId,
      sessionName: getSessionByKey(key)?.name ?? sessionId,
      requestId,
      requestedAt: performance.now(),
      readyAt: null,
      firstByteAt: null,
      replayReceivedAt: null,
      firstWriteFlushAt: null,
      replayBytesExpected: null,
      replayLineBreaks: null,
      replayTrimmed: false,
      replayBytesReceived: 0,
      replayChunkCount: 0,
      attachMode: mode,
      snapshotBackend: null,
    }
    updateAttachMetric(metric)
    pendingRequestRef.current = { hostId, requestId, kind: 'attach' }
    pendingAttachTargetKeyRef.current = key
    pendingSnapshotAttachRef.current = null
    dropBinaryUntilReadyRef.current = false
    scrollToBottomAfterAttachBinaryRef.current = key
    const useSnapshotAttach = mode === 'snapshot' && SNAPSHOT_ATTACH_ENABLED
    sendToHost(hostId, { type: useSnapshotAttach ? 'attach-snapshot' : 'attach', id: sessionId, requestId, renderer: terminalRenderer, ...dims })
  }, [getSessionByKey, sendToHost, terminalRenderer, updateAttachMetric])

  const prepareTerminalForAttach = useCallback((key: SessionKey) => {
    const container = containerRefs.current.get(key)
    if (container) tm.ensureTerminal(key, container)
    tm.setActive(key)
    return tm.getMeasuredDimensions(key)
  }, [tm])

  const syncSessionSize = useCallback((key: SessionKey) => {
    const dims = prepareTerminalForAttach(key)
    if (!dims) return null
    flushPendingTerminalResize()
    sendTerminalResize(key, dims.cols, dims.rows, true)
    return dims
  }, [flushPendingTerminalResize, prepareTerminalForAttach, sendTerminalResize])

  // Expose send on window in dev so Playwright tests can send WS messages
  // directly (e.g. bulk-kill sessions) without driving the UI.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const roundMs = (value: number | null) => value == null ? null : Math.round(value * 10) / 10
    const resolveTerminalKey = (rawId: string) => {
      if (!rawId) return null
      if (currentKeyRef.current && parseKey(currentKeyRef.current).sessionId === rawId) return currentKeyRef.current
      const direct = rawId.includes(':') ? rawId as SessionKey : null
      if (direct) return direct
      for (const host of hosts) {
        const candidate = makeKey(host.id, rawId)
        if (getSessionByKey(candidate)) return candidate
      }
      return null
    }
    const getOrderedSessionTargets = (hostId?: string) => {
      const targetHostIds = hostId ? [hostId] : hosts.map(host => host.id)
      const targets: Array<{ key: SessionKey; hostId: string; sessionId: string; sessionName: string }> = []
      for (const nextHostId of targetHostIds) {
        const list = hostSessionsRef.current.get(nextHostId) ?? []
        const order = sessionOrderByHostRef.current[nextHostId] ?? []
        const sorted = [...list].sort((a, b) => {
          const ai = order.indexOf(a.id)
          const bi = order.indexOf(b.id)
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        })
        for (const session of sorted) {
          targets.push({
            key: makeKey(nextHostId, session.id),
            hostId: nextHostId,
            sessionId: session.id,
            sessionName: session.name,
          })
        }
      }
      return targets
    }
    const summarizeAttachMetric = (metric: AttachReplayMetric) => ({
      attachMode: metric.attachMode,
      snapshotBackend: metric.snapshotBackend,
      hostId: metric.hostId,
      sessionId: metric.sessionId,
      sessionName: metric.sessionName,
      requestId: metric.requestId,
      replayBytes: metric.replayBytesExpected,
      replayKiB: metric.replayBytesExpected == null ? null : Math.round((metric.replayBytesExpected / 1024) * 10) / 10,
      replayLineBreaks: metric.replayLineBreaks,
      replayTrimmed: metric.replayTrimmed,
      replayChunks: metric.replayChunkCount,
      readyMs: roundMs(metric.readyAt == null ? null : metric.readyAt - metric.requestedAt),
      firstByteMs: roundMs(metric.firstByteAt == null ? null : metric.firstByteAt - metric.requestedAt),
      replayReceivedMs: roundMs(metric.replayReceivedAt == null ? null : metric.replayReceivedAt - metric.requestedAt),
      firstWriteFlushMs: roundMs(metric.firstWriteFlushAt == null ? null : metric.firstWriteFlushAt - metric.requestedAt),
      readyToFirstByteMs: roundMs(metric.readyAt == null || metric.firstByteAt == null ? null : metric.firstByteAt - metric.readyAt),
      readyToReplayReceivedMs: roundMs(metric.readyAt == null || metric.replayReceivedAt == null ? null : metric.replayReceivedAt - metric.readyAt),
      readyToFirstWriteFlushMs: roundMs(metric.readyAt == null || metric.firstWriteFlushAt == null ? null : metric.firstWriteFlushAt - metric.readyAt),
    })
    const waitForAttachMetric = (key: SessionKey, startedAfter: number, timeoutMs: number) => new Promise((resolve) => {
      const deadline = performance.now() + timeoutMs
      const timer = window.setInterval(() => {
        const latestMetric = latestAttachMetricByKeyRef.current.get(key)
        if (latestMetric && latestMetric.requestedAt >= startedAfter) {
          const replayBytes = latestMetric.replayBytesExpected ?? 0
          const done = latestMetric.replayReceivedAt !== null && (replayBytes === 0 || latestMetric.firstWriteFlushAt !== null)
          if (done) {
            window.clearInterval(timer)
            resolve({ ...summarizeAttachMetric(latestMetric), timedOut: false })
            return
          }
        }
        if (performance.now() < deadline) return
        window.clearInterval(timer)
        if (latestMetric && latestMetric.requestedAt >= startedAfter) {
          resolve({ ...summarizeAttachMetric(latestMetric), timedOut: true })
          return
        }
        const fallback = parseKey(key)
        resolve({
          hostId: fallback.hostId,
          sessionId: fallback.sessionId,
          sessionName: getSessionByKey(key)?.name ?? fallback.sessionId,
          requestId: null,
          replayBytes: null,
          replayKiB: null,
          replayLineBreaks: null,
          replayTrimmed: null,
          replayChunks: null,
          readyMs: null,
          firstByteMs: null,
          replayReceivedMs: null,
          firstWriteFlushMs: null,
          readyToFirstByteMs: null,
          readyToReplayReceivedMs: null,
          readyToFirstWriteFlushMs: null,
          timedOut: true,
        })
      }, 25)
    })
    const buildStudyReport = async (
      scope: 'current' | 'all',
      options?: { hostId?: string; pauseMs?: number; timeoutMs?: number },
    ) => {
      const results = scope === 'current'
        ? [await (window as any).__wt_attach_metrics.compareCurrent(options)]
        : await (window as any).__wt_attach_metrics.compareAll(options)
      const sidecar = await fetch('/api/sidecar')
        .then(async res => res.ok ? await res.json() as SidecarStatus : null)
        .catch(() => null)
      return {
        capturedAt: new Date().toISOString(),
        scope,
        renderer: terminalRenderer,
        userAgent: navigator.userAgent,
        url: location.href,
        sidecar,
        sessions: (window as any).__wt_attach_metrics.sessions(options?.hostId),
        results,
      }
    }
    const copyJson = async (value: unknown) => {
      const text = JSON.stringify(value, null, 2)
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      }
      return text
    }
    ;(window as any).__wt_send = (obj: object) => sendToHost(localHostId, obj)
    ;(window as any).__wt_ws_close = () => forceClose(localHostId)
    ;(window as any).__wt_get_attached_id = () => {
      const key = attachedKeyRef.current
      return key ? parseKey(key).sessionId : null
    }
    ;(window as any).__wt_terminal_debug = {
      getRenderer: () => terminalRenderer,
      getText: (sessionId: string) => {
        const key = resolveTerminalKey(sessionId)
        return key ? tm.getBufferText(key) : ''
      },
      hasPrompt: (sessionId: string) => {
        const key = resolveTerminalKey(sessionId)
        if (!key) return false
        const text = tm.getBufferText(key)
        return text.split('\n').some(line => line.trim().length > 0)
      },
      getState: (sessionId: string) => {
        const key = resolveTerminalKey(sessionId)
        if (!key) return null
        return {
          opened: tm.isOpened(key),
          scroll: tm.getScrollState(key),
          text: tm.getBufferText(key),
        }
      },
      getLineCells: (sessionId: string, lineIndex: number) => {
        const key = resolveTerminalKey(sessionId)
        if (!key) return null
        const term = tm.getDebugTerm(key) as {
          buffer?: {
            active?: {
              getLine?: (index: number) => {
                length: number
                getCell: (cellIndex: number) => {
                  getChars: () => string
                  getWidth: () => number
                  getFgColor: () => number
                  getFgColorMode: () => number
                  getBgColor: () => number
                  getBgColorMode: () => number
                  isBold: () => boolean
                  isItalic: () => boolean
                  isUnderline: () => boolean
                } | null
              } | null
            }
          }
        } | null
        const line = term?.buffer?.active?.getLine?.(lineIndex)
        if (!line) return null
        const cells = []
        for (let i = 0; i < line.length; i += 1) {
          const cell = line.getCell(i)
          if (!cell) continue
          cells.push({
            chars: cell.getChars(),
            width: cell.getWidth(),
            fg: cell.getFgColor(),
            fgMode: cell.getFgColorMode(),
            bg: cell.getBgColor(),
            bgMode: cell.getBgColorMode(),
            bold: cell.isBold(),
            italic: cell.isItalic(),
            underline: cell.isUnderline(),
          })
        }
        return cells
      },
      scrollToTop: (sessionId: string) => {
        const key = resolveTerminalKey(sessionId)
        if (key) tm.scrollToTop(key)
      },
      scrollToBottom: (sessionId: string) => {
        const key = resolveTerminalKey(sessionId)
        if (key) tm.scrollToBottom(key)
      },
      focus: (sessionId: string) => {
        const key = resolveTerminalKey(sessionId)
        if (key) tm.focus(key)
      },
    }
    ;(window as any).__wt_renderer = {
      get: () => terminalRenderer,
      set: (renderer: TerminalRenderer) => {
        persistTerminalRenderer(renderer)
        location.reload()
      },
    }
    ;(window as any).__wt_attach_metrics = {
      sessions: (hostId?: string) => getOrderedSessionTargets(hostId).map(target => ({
        hostId: target.hostId,
        sessionId: target.sessionId,
        sessionName: target.sessionName,
        current: currentKeyRef.current === target.key,
      })),
      latest: (rawId?: string) => {
        if (rawId) {
          const key = resolveTerminalKey(rawId)
          if (!key) return null
          const metric = latestAttachMetricByKeyRef.current.get(key)
          return metric ? summarizeAttachMetric(metric) : null
        }
        return [...latestAttachMetricByKeyRef.current.values()]
          .sort((a, b) => b.requestedAt - a.requestedAt)
          .map(summarizeAttachMetric)
      },
      measureSession: async (rawId: string, options?: { timeoutMs?: number; mode?: AttachMode }) => {
        const key = resolveTerminalKey(rawId)
        if (!key) throw new Error(`Unknown session: ${rawId}`)
        const startedAfter = performance.now()
        const dims = syncSessionSize(key)
        if (!dims) throw new Error(`Terminal not ready for attach: ${rawId}`)
        sendAttachRequest(key, dims, options?.mode ?? 'snapshot')
        return await waitForAttachMetric(key, startedAfter, options?.timeoutMs ?? 60_000)
      },
      compareSession: async (rawId: string, options?: { timeoutMs?: number; pauseMs?: number }) => {
        const raw = await (window as any).__wt_attach_metrics.measureSession(rawId, {
          timeoutMs: options?.timeoutMs,
          mode: 'raw',
        })
        if ((options?.pauseMs ?? 150) > 0) {
          await new Promise(resolve => window.setTimeout(resolve, options?.pauseMs ?? 150))
        }
        const snapshot = await (window as any).__wt_attach_metrics.measureSession(rawId, {
          timeoutMs: options?.timeoutMs,
          mode: 'snapshot',
        })
        const result = { raw, snapshot }
        console.table([raw, snapshot])
        return result
      },
      compareCurrent: async (options?: { timeoutMs?: number; pauseMs?: number }) => {
        const current = currentKeyRef.current
        if (!current) throw new Error('No current session')
        return await (window as any).__wt_attach_metrics.compareSession(parseKey(current).sessionId, options)
      },
      measureAll: async (options?: { hostId?: string; pauseMs?: number; timeoutMs?: number }) => {
        const rows = []
        const targets = getOrderedSessionTargets(options?.hostId)
        for (const target of targets) {
          const startedAfter = performance.now()
          const dims = syncSessionSize(target.key)
          if (!dims) throw new Error(`Terminal not ready for attach: ${target.sessionName}`)
          sendAttachRequest(target.key, dims, 'snapshot')
          rows.push(await waitForAttachMetric(target.key, startedAfter, options?.timeoutMs ?? 60_000))
          if ((options?.pauseMs ?? 150) > 0) {
            await new Promise(resolve => window.setTimeout(resolve, options?.pauseMs ?? 150))
          }
        }
        console.table(rows)
        return rows
      },
      compareAll: async (options?: { hostId?: string; pauseMs?: number; timeoutMs?: number }) => {
        const rows = []
        const targets = getOrderedSessionTargets(options?.hostId)
        for (const target of targets) {
          rows.push(await (window as any).__wt_attach_metrics.compareSession(target.sessionId, options))
        }
        return rows
      },
      studyCurrent: async (options?: { pauseMs?: number; timeoutMs?: number }) => {
        const report = await buildStudyReport('current', options)
        console.log(report)
        return report
      },
      studyAll: async (options?: { hostId?: string; pauseMs?: number; timeoutMs?: number }) => {
        const report = await buildStudyReport('all', options)
        console.log(report)
        return report
      },
      copyStudyCurrent: async (options?: { pauseMs?: number; timeoutMs?: number }) => {
        const report = await buildStudyReport('current', options)
        const text = await copyJson(report)
        console.log(report)
        return text
      },
      copyStudyAll: async (options?: { hostId?: string; pauseMs?: number; timeoutMs?: number }) => {
        const report = await buildStudyReport('all', options)
        const text = await copyJson(report)
        console.log(report)
        return text
      },
      help: 'Use sessions(), compareCurrent(), compareSession(id), measureSession(id, { mode }), measureAll(), compareAll(), studyCurrent(), studyAll(), copyStudyCurrent(), or copyStudyAll() from the browser console.',
    }
  }, [forceClose, getSessionByKey, hosts, localHostId, sendAttachRequest, sendToHost, syncSessionSize, terminalRenderer, tm])

  const toWsUrl = useCallback((baseUrl: string) => {
    const next = new URL(baseUrl)
    next.protocol = next.protocol === 'https:' ? 'wss:' : 'ws:'
    next.pathname = '/ws'
    next.search = ''
    next.hash = ''
    return next.toString()
  }, [])

  const shouldConnectHostImmediately = useCallback((host: Host) => {
    if (host.local) return true
    try {
      return new URL(host.url).origin === location.origin
    } catch {
      return false
    }
  }, [])

  const peerConnectionPlanKey = useMemo(
    () => hosts.map(host => `${host.id}|${host.url}|${host.local ? '1' : '0'}`).join(','),
    [hosts],
  )

  useEffect(() => {
    setBackgroundPeerConnectionsReady(false)
    const timerId = window.setTimeout(() => setBackgroundPeerConnectionsReady(true), 2000)
    return () => window.clearTimeout(timerId)
  }, [peerConnectionPlanKey])

  useEffect(() => {
    const activeHostId = currentKeyRef.current ? parseKey(currentKeyRef.current).hostId : localHostId
    const desiredHostIds = new Set(
      hosts
        .filter(host => shouldConnectHostImmediately(host) || host.id === activeHostId || backgroundPeerConnectionsReady)
        .map(host => host.id),
    )
    for (const host of hosts) {
      if (!desiredHostIds.has(host.id)) continue
      connect(host.id, toWsUrl(host.local ? location.origin : host.url))
    }
    for (const hostId of hostStatuses.keys()) {
      if (!desiredHostIds.has(hostId)) disconnect(hostId)
    }
  }, [backgroundPeerConnectionsReady, connect, disconnect, hostStatuses, hosts, localHostId, shouldConnectHostImmediately, toWsUrl])

  useEffect(() => {
    let cancelled = false
    const loadHosts = async () => {
      try {
        const res = await fetch('/api/host')
        if (!res.ok) return
        const json = await res.json() as {
          self?: { id?: unknown; name?: unknown }
          peers?: Array<{ id?: unknown; name?: unknown; url?: unknown }>
        }
        if (cancelled) return
        const selfId = normalizeHostId(json.self?.id, LEGACY_LOCAL_HOST_ID)
        const selfName = normalizeHostName(json.self?.name, 'Local Host')
        const seen = new Set<string>([selfId])
        const peers = (json.peers ?? []).flatMap(peer => {
          const id = normalizeHostId(peer.id, '')
          if (!id || seen.has(id)) return []
          if (typeof peer.url !== 'string' || peer.url.trim().length === 0) return []
          seen.add(id)
          return [{
            id,
            name: normalizeHostName(peer.name, id),
            url: peer.url,
            local: false,
          }]
        })
        setHosts([
          { id: selfId, name: selfName, url: location.origin, local: true },
          ...peers,
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

  useEffect(() => {
    let cancelled = false
    let intervalId: number | null = null

    const loadSidecar = async () => {
      try {
        const res = await fetch('/api/sidecar')
        if (!res.ok) return
        const json = await res.json() as SidecarStatus
        if (cancelled) return
        setSidecarStatus(json)
      } catch {
        // ignore sidecar status failures
      }
    }

    void loadSidecar()
    if (import.meta.env.DEV) {
      intervalId = window.setInterval(() => { void loadSidecar() }, 5000)
    }

    return () => {
      cancelled = true
      if (intervalId !== null) window.clearInterval(intervalId)
    }
  }, [])

  // Header clock + sky indicator — updates DOM directly via ref to avoid re-renders
  const clockRef = useRef<HTMLDivElement>(null)
  const skyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function tick() {
      const now = new Date()
      if (clockRef.current) {
        const h = String(now.getHours()).padStart(2, '0')
        const m = String(now.getMinutes()).padStart(2, '0')
        const s = String(now.getSeconds()).padStart(2, '0')
        clockRef.current.textContent = `${h}:${m}:${s}`
      }
      if (skyRef.current) {
        // Sun altitude as fraction of day: 0=midnight, 0.5=noon
        const frac = (now.getHours() + now.getMinutes() / 60) / 24
        // Sky phases: night(0-5), dawn(5-7), day(7-17), dusk(17-19), night(19-24)
        const el = skyRef.current
        el.className = 'sky-indicator'
        if (frac < 5/24 || frac >= 20/24) {
          el.classList.add('sky-night')
        } else if (frac < 7/24) {
          el.classList.add('sky-dawn')
        } else if (frac < 17.5/24) {
          el.classList.add('sky-day')
        } else {
          el.classList.add('sky-dusk')
        }
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Mobile keyboard avoidance: move fixed overlays/toolbar above the on-screen
  // keyboard and shrink the terminal area so xterm remains visible while typing.
  useEffect(() => {
    let raf = 0
    let last = -1
    const root = document.documentElement

    const applyInset = () => {
      raf = 0
      const next = getMobileKeyboardInset()
      if (next === last) return
      last = next
      setMobileKeyboardInset(next)
      root.style.setProperty('--mobile-keyboard-inset', `${next}px`)
    }

    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(applyInset)
    }

    applyInset()

    const vv = window.visualViewport
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      setMobileKeyboardInset(0)
      root.style.setProperty('--mobile-keyboard-inset', '0px')
    }
  }, [])

  useEffect(() => {
    if (!currentKey) return
    const timeoutId = window.setTimeout(() => {
      requestAnimationFrame(() => {
        syncSessionSize(currentKey)
      })
    }, MOBILE_KEYBOARD_RESIZE_SETTLE_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [currentKey, mobileKeyboardInset, syncSessionSize])

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
          const dims = syncSessionSize(key)
          tm.reset(key)
          if (dims) {
            sendAttachRequest(key, dims)
          } else {
            queuedAttachKeyRef.current = key
          }
        }
      }
      if (prev === 'connected' && next !== 'connected') {
        if (pendingRequestRef.current?.hostId === host.id) {
          pendingRequestRef.current = null
          pendingAttachTargetKeyRef.current = null
          if (pendingSnapshotAttachRef.current?.hostId === host.id) {
            pendingSnapshotAttachRef.current = null
          }
          if (queuedAttachKeyRef.current && parseKey(queuedAttachKeyRef.current).hostId === host.id) {
            queuedAttachKeyRef.current = null
          }
          dropBinaryUntilReadyRef.current = false
          if (scrollToBottomAfterAttachBinaryRef.current && parseKey(scrollToBottomAfterAttachBinaryRef.current).hostId === host.id) {
            scrollToBottomAfterAttachBinaryRef.current = null
          }
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
    const dims = prepareTerminalForAttach(currentKey)
    if (queuedAttachKeyRef.current === currentKey && dims) {
      queuedAttachKeyRef.current = null
      const synced = syncSessionSize(currentKey)
      if (synced) sendAttachRequest(currentKey, synced)
    } else if (attachedKeyRef.current === currentKey && dims) {
      flushPendingTerminalResize()
      sendTerminalResize(currentKey, dims.cols, dims.rows, true)
    }
    if (shouldAutoFocusTerminalOnSessionSelect()) {
      tm.focus(currentKey)
    }
  }, [currentKey, flushPendingTerminalResize, prepareTerminalForAttach, sendAttachRequest, sendTerminalResize, sessions.length, tm])

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

  useEffect(() => {
    setTextSelectionOpen(false)
  }, [currentKey])

  // hashchange: if the user manually edits the URL hash, navigate to that session
  useEffect(() => {
    const handler = () => {
      const route = parseHashRoute(location.hash)
      if (!route) return
      const list = hostSessionsRef.current.get(route.hostId) ?? []
      const s = list.find(session => session.name === route.target) ?? list.find(session => session.id === route.target)
      if (s) attachSession(makeKey(route.hostId, s.id))
    }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [parseHashRoute]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const activeHostId = currentKeyRef.current ? parseKey(currentKeyRef.current).hostId : localHostId
      const activeKey = currentKeyRef.current
      const isMacPlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) || /Mac OS|iPhone|iPad|iPod/i.test(navigator.userAgent)
      if (isMacPlatform && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyR') {
        e.preventDefault()
        e.stopPropagation()
        location.reload()
        return
      }
      const sendShortcutInput = (data: string) => {
        if (!activeKey) return
        e.preventDefault()
        e.stopPropagation()
        sendToHost(parseKey(activeKey).hostId, { type: 'input', data })
      }
      if (!shouldIgnoreGlobalTerminalShortcutTarget(e.target)) {
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft') {
          sendShortcutInput('\x1bb')
          return
        }
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowRight') {
          sendShortcutInput('\x1bf')
          return
        }
        if (isMacPlatform && e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowLeft') {
          sendShortcutInput('\x01')
          return
        }
        if (isMacPlatform && e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowRight') {
          sendShortcutInput('\x05')
          return
        }
      }
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
        const hostOrder = sessionOrderByHostRef.current[activeHostId] ?? []
        const ordered = [...(hostSessionsRef.current.get(activeHostId) ?? [])].sort((a, b) => {
          const ai = hostOrder.indexOf(a.id)
          const bi = hostOrder.indexOf(b.id)
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        })
        const s = ordered[parseInt(e.code[5]) - 1]
        if (s) attachSession(makeKey(activeHostId, s.id))
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
        const reportedId = normalizeHostId(m.id, hostId)
        const reportedName = normalizeHostName(m.name, '')
        reconcileLocalHostIdentity(hostId, reportedId, reportedName)
        break
      }

      case 'sessions': {
        const list = (m.list as Session[]).map(s => ({ ...s, hostId }))
        setHostSessions(prev => {
          const next = new Map(prev)
          next.set(hostId, list)
          return next
        })
        // After the first sessions list arrives for the hash target host,
        // navigate to the hash route. Bare '#name' targets local host.
        if (!hasHandledInitialHashRef.current) {
          const route = parseHashRoute(location.hash)
          if (route) {
            if (route.hostId !== hostId || list.length === 0) break
            hasHandledInitialHashRef.current = true
            const match = list.find(s => s.name === route.target)
              ?? list.find(s => s.id === route.target)
              ?? list[0]
            attachSession(makeKey(hostId, match.id))
          } else if (hostId === localHostId && list.length > 0) {
            hasHandledInitialHashRef.current = true
            attachSession(makeKey(hostId, list[0].id))
          }
        }
        break
      }

      case 'ready': {
        const id = m.id as string
        const name = m.name as string
        const replayBytes = typeof m.replayBytes === 'number' && Number.isFinite(m.replayBytes)
          ? Math.max(0, Math.floor(m.replayBytes))
          : 0
        const replayLineBreaks = typeof m.replayLineBreaks === 'number' && Number.isFinite(m.replayLineBreaks)
          ? Math.max(0, Math.floor(m.replayLineBreaks))
          : 0
        const replayTrimmed = m.replayTrimmed === true
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
        const readyAt = performance.now()
        if (requestId) {
          const metric = attachMetricsByRequestIdRef.current.get(requestId)
          if (metric) {
            updateAttachMetric({
              ...metric,
              key,
              hostId: parseKey(key).hostId,
              sessionId: parseKey(key).sessionId,
              sessionName: name,
              readyAt,
              replayBytesExpected: replayBytes,
              replayLineBreaks,
              replayTrimmed,
              replayReceivedAt: replayBytes === 0 ? readyAt : metric.replayReceivedAt,
              snapshotBackend: null,
            })
          }
        }
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
        replaceHash(parseKey(key).hostId, name)

        // If this was a duplicate, insert the new session right after its source
        if (duplicateSourceKeyRef.current) {
          const sourceKey = duplicateSourceKeyRef.current
          duplicateSourceKeyRef.current = null
          const source = parseKey(sourceKey)
          const created = parseKey(key)
          setSessionOrderByHost(prev => {
            const current = [...(prev[source.hostId] ?? [])].filter(x => x !== created.sessionId)
            const sourceIdx = current.indexOf(source.sessionId)
            if (sourceIdx !== -1) current.splice(sourceIdx + 1, 0, created.sessionId)
            else current.push(created.sessionId)
            return { ...prev, [source.hostId]: current }
          })
        }

        break
      }

      case 'snapshot-ready': {
        const id = m.id as string
        const name = m.name as string
        const requestId = typeof m.requestId === 'string' ? m.requestId : null
        const pending = pendingRequestRef.current
        if (!requestId || !pending || pending.kind !== 'attach') return
        if (requestId !== pending.requestId || pending.hostId !== hostId) {
          dropBinaryUntilReadyRef.current = true
          return
        }
        pendingRequestRef.current = null
        let key: SessionKey | null = pendingAttachTargetKeyRef.current
        pendingAttachTargetKeyRef.current = null
        dropBinaryUntilReadyRef.current = false
        if (!key) key = makeKey(hostId, id)

        const snapshot = m.snapshot as TerminalSnapshot | undefined
        const cutSeq = typeof m.cutSeq === 'number' && Number.isFinite(m.cutSeq) ? Math.max(0, Math.floor(m.cutSeq)) : 0
        if (!snapshot || typeof snapshot !== 'object' || !('format' in snapshot)) {
          sendToHost(hostId, { type: 'attach', id, requestId, cols: tm.getDimensions(key).cols, rows: tm.getDimensions(key).rows })
          pendingRequestRef.current = { hostId, requestId, kind: 'attach' }
          pendingAttachTargetKeyRef.current = key
          return
        }

        const readyAt = performance.now()
        const metric = attachMetricsByRequestIdRef.current.get(requestId)
        if (metric) {
          updateAttachMetric({
            ...metric,
            key,
            hostId: parseKey(key).hostId,
            sessionId: parseKey(key).sessionId,
              sessionName: name,
              readyAt,
              firstByteAt: readyAt,
              replayBytesExpected: 'payload' in snapshot && typeof snapshot.payload === 'string' ? snapshot.payload.length : null,
              replayBytesReceived: 'payload' in snapshot && typeof snapshot.payload === 'string' ? snapshot.payload.length : 0,
              replayLineBreaks: metric.replayLineBreaks,
              replayTrimmed: false,
              replayReceivedAt: readyAt,
              snapshotBackend: typeof m.backend === 'string' ? m.backend : null,
          })
        }

        currentKeyRef.current = key
        tm.primeTerminal(key)
        setCurrentKey(key)
        replaceHash(parseKey(key).hostId, name)

        const restored = tm.restoreSnapshot(key, snapshot, () => handleAttachWriteFlushed(key))
        if (!restored) {
          pendingSnapshotAttachRef.current = null
          sendToHost(hostId, { type: 'attach', id, requestId, cols: snapshot.cols, rows: snapshot.rows })
          pendingRequestRef.current = { hostId, requestId, kind: 'attach' }
          pendingAttachTargetKeyRef.current = key
          return
        }

        pendingSnapshotAttachRef.current = {
          key,
          hostId,
          sessionId: id,
          sessionName: name,
          requestId,
          cutSeq,
        }
        sendToHost(hostId, { type: 'snapshot-applied', id, requestId })
        break
      }

      case 'snapshot-tail': {
        const pending = pendingSnapshotAttachRef.current
        const requestId = typeof m.requestId === 'string' ? m.requestId : null
        if (!pending || requestId !== pending.requestId || hostId !== pending.hostId) return
        if (m.id !== pending.sessionId || typeof m.data !== 'string') return
        forwardTerminalBinary(pending.key, decodeBase64Utf8(m.data))
        break
      }

      case 'snapshot-complete': {
        const pending = pendingSnapshotAttachRef.current
        const requestId = typeof m.requestId === 'string' ? m.requestId : null
        if (!pending || requestId !== pending.requestId || hostId !== pending.hostId) return
        if (m.id !== pending.sessionId) return
        pendingSnapshotAttachRef.current = null
        attachedKeyRef.current = pending.key
        currentKeyRef.current = pending.key
        setCurrentKey(pending.key)
        replaceHash(parseKey(pending.key).hostId, pending.sessionName)
        break
      }

      case 'error': {
        const requestId = typeof m.requestId === 'string' ? m.requestId : null
        if (!requestId || requestId !== pendingRequestRef.current?.requestId || hostId !== pendingRequestRef.current.hostId) break
        pendingRequestRef.current = null
        pendingAttachTargetKeyRef.current = null
        dropBinaryUntilReadyRef.current = false
        scrollToBottomAfterAttachBinaryRef.current = null
        const fallback = attachedKeyRef.current
        currentKeyRef.current = fallback
        setCurrentKey(fallback)
        if (fallback) {
          tm.setActive(fallback)
          if (shouldAutoFocusTerminalOnSessionSelect()) {
            tm.focus(fallback)
          }
          const name = getSessionByKey(fallback)?.name ?? parseKey(fallback).sessionId
          replaceHash(parseKey(fallback).hostId, name)
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
        if (pendingSnapshotAttachRef.current?.key === key) {
          pendingSnapshotAttachRef.current = null
        }
        if (queuedAttachKeyRef.current === key) {
          queuedAttachKeyRef.current = null
        }
        if (scrollToBottomAfterAttachBinaryRef.current === key) {
          scrollToBottomAfterAttachBinaryRef.current = null
        }
        setShowScrollToBottomByKey(prev => {
          if (!prev[key]) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
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
            const hostOrder = sessionOrderByHostRef.current[hostId] ?? []
            const killedIdx = hostOrder.indexOf(id)
            const ordered = [...remaining].sort((a, b) => {
              const ai = hostOrder.indexOf(a.id)
              const bi = hostOrder.indexOf(b.id)
              return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
            })
            // Prefer the session that was right after the killed one; fall back to last
            const next = ordered.find(s => hostOrder.indexOf(s.id) > killedIdx) ?? ordered[ordered.length - 1]
            attachSession(makeKey(hostId, next.id))
          }
        }
        break
      }
    }
  }

  function newSession(hostId = (currentKeyRef.current ? parseKey(currentKeyRef.current).hostId : localHostId), cwd?: string) {
    const dims = currentKeyRef.current
      ? tm.getDimensions(currentKeyRef.current)
      : { cols: 80, rows: 24 }
    const requestId = `create-${++nextRequestSeqRef.current}`
    pendingRequestRef.current = { hostId, requestId, kind: 'create' }
    pendingAttachTargetKeyRef.current = null
    dropBinaryUntilReadyRef.current = false
    sendToHost(hostId, { type: 'create', requestId, ...(cwd ? { cwd } : {}), ...dims })
  }

  function duplicateSession(sourceKey: SessionKey) {
    const { hostId, sessionId } = parseKey(sourceKey)
    const source = (hostSessionsRef.current.get(hostId) ?? []).find(s => s.id === sessionId)
    duplicateSourceKeyRef.current = sourceKey
    newSession(hostId, source?.cwd || undefined)
  }

  function attachSession(key: SessionKey) {
    if (key === currentKeyRef.current) {
      syncSessionSize(key)
      if (shouldAutoFocusTerminalOnSessionSelect()) {
        tm.focus(key)
      }
      return
    }
    const currentHostId = currentKeyRef.current ? parseKey(currentKeyRef.current).hostId : null
    const nextHostId = parseKey(key).hostId
    if (currentHostId && currentHostId !== nextHostId) {
      sendToHost(currentHostId, { type: 'detach' })
    }
    const dims = syncSessionSize(key)
    // Clear existing content — server always replays the full scrollback buffer
    // on every attach, so we must reset first to avoid duplication.
    tm.reset(key)
    // Optimistic: make pane visible immediately. On narrow mobile layouts we
    // intentionally avoid auto-focus so session taps do not summon/zoom the
    // on-screen keyboard; the toolbar keyboard button remains the explicit path.
    currentKeyRef.current = key
    setCurrentKey(key)
    if (shouldAutoFocusTerminalOnSessionSelect()) {
      tm.focus(key)
    }
    if (dims) {
      sendAttachRequest(key, dims)
    } else {
      queuedAttachKeyRef.current = key
    }
    // Update URL hash for bookmarking / deeplink — use name not UUID
    const parsed = parseKey(key)
    const name = getSessionByKey(key)?.name ?? parsed.sessionId
    replaceHash(parsed.hostId, name)
  }
  attachSessionRef.current = attachSession

  function killSession(key: SessionKey) {
    const { hostId, sessionId } = parseKey(key)
    sendToHost(hostId, { type: 'kill', id: sessionId })
    setKillTargetKey(null)
  }

  function renameSession(key: SessionKey, name: string) {
    const { hostId, sessionId } = parseKey(key)
    setHostSessions(prev => {
      const next = new Map(prev)
      const list = next.get(hostId) ?? []
      next.set(hostId, list.map(s => s.id === sessionId ? { ...s, name } : s))
      return next
    })
    sendToHost(hostId, { type: 'rename', id: sessionId, name })
    // Keep URL hash in sync if this is the current session
    if (key === currentKeyRef.current) {
      replaceHash(hostId, name)
    }
  }

  function reorderSessions(fromKey: SessionKey, toKey: SessionKey) {
    const from = parseKey(fromKey)
    const to = parseKey(toKey)
    if (from.hostId !== to.hostId) return
    setSessionOrderByHost(prev => {
      const next = [...(prev[from.hostId] ?? [])].filter(id => id !== from.sessionId)
      const toIdx = next.indexOf(to.sessionId)
      if (toIdx === -1) next.push(from.sessionId)
      else next.splice(toIdx, 0, from.sessionId)
      return { ...prev, [from.hostId]: next }
    })
  }

  function reorderSessionToEnd(fromKey: SessionKey, hostId: string) {
    const from = parseKey(fromKey)
    if (from.hostId !== hostId) return
    setSessionOrderByHost(prev => {
      const next = [...(prev[hostId] ?? [])].filter(id => id !== from.sessionId)
      next.push(from.sessionId)
      return { ...prev, [hostId]: next }
    })
  }

  function sendInput(data: string) {
    const key = currentKeyRef.current
    if (!key) return
    sendToHost(parseKey(key).hostId, { type: 'input', data })
  }

  function sendArrowInput(direction: ArrowDirection) {
    const key = currentKeyRef.current
    if (!key) return
    const applicationCursorKeysMode = tm.getApplicationCursorKeysMode(key)
    sendToHost(parseKey(key).hostId, {
      type: 'input',
      data: getArrowSequence(direction, applicationCursorKeysMode),
    })
  }

  function refreshTerminalLayout() {
    const key = currentKeyRef.current
    if (!key) return
    const { cols, rows } = tm.getDimensions(key)
    if (cols <= 1 || rows <= 0) return
    const hostId = parseKey(key).hostId
    sendToHost(hostId, { type: 'resize', cols: cols + 1, rows })
    window.setTimeout(() => {
      if (currentKeyRef.current !== key) return
      sendToHost(hostId, { type: 'resize', cols, rows })
    }, 100)
  }

  async function copyCurrentStudy() {
    const metrics = (window as any).__wt_attach_metrics
    if (!metrics?.copyStudyCurrent) return
    try {
      await metrics.copyStudyCurrent()
      setStudyCopyState('copied')
      window.setTimeout(() => setStudyCopyState('idle'), 2000)
    } catch {
      setStudyCopyState('error')
      window.setTimeout(() => setStudyCopyState('idle'), 2500)
    }
  }

  async function restartSidecar() {
    setRestartingSidecar(true)
    try {
      const res = await fetch('/api/sidecar/restart', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to restart ptyd')
      const json = await res.json() as SidecarStatus & { ok?: boolean }
      setSidecarStatus({
        baseUrl: json.baseUrl,
        wsUrl: json.wsUrl,
        port: json.port,
        expectedProtocolVersion: json.expectedProtocolVersion,
        protocolCompatible: json.protocolCompatible,
        health: json.health,
      })
      setRestartSidecarModalOpen(false)
    } finally {
      setRestartingSidecar(false)
    }
  }

  function scrollToBottom() {
    const key = currentKeyRef.current
    if (!key) return
    tm.scrollToBottom(key)
  }

  function refreshTextSelectionSnapshot() {
    const key = currentKeyRef.current
    if (!key) {
      setTextSelectionSnapshot('')
      return
    }
    setTextSelectionSnapshot(tm.getBufferText(key))
  }

  function openTextSelection() {
    refreshTextSelectionSnapshot()
    setTextSelectionOpen(true)
  }

  const switchTerminalRenderer = useCallback((nextRenderer: TerminalRenderer) => {
    if (nextRenderer === terminalRenderer || switchingRenderer) return
    setSwitchingRenderer(nextRenderer)
    persistTerminalRenderer(nextRenderer)
    location.reload()
  }, [switchingRenderer, terminalRenderer])

  const killTarget = killTargetKey ? getSessionByKey(killTargetKey) : null
  const showScrollToBottomOverlay = !!(currentKey && showScrollToBottomByKey[currentKey])
  const terminalEntries = useMemo(() => {
    const next: Array<{ key: SessionKey; session: Session }> = []
    for (const host of hosts) {
      for (const session of orderedHostSessions.get(host.id) ?? []) {
        next.push({ key: makeKey(host.id, session.id), session })
      }
    }
    return next
  }, [hosts, orderedHostSessions])
  const showStaleSidecar = sidecarStatus?.health?.staleRuntime === true || sidecarStatus?.protocolCompatible === false

  return (
    <div className="app">
      <header className="header">
        <button className="hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle sidebar">
          <span /><span /><span />
        </button>
        <div className="wordmark"><span className="prompt">$</span> ting<span className="dot">.</span>sh<span className="cursor" /></div>
        <div className="header-spacer" />
        <div className="header-time">
          {showStaleSidecar && (
            <>
              <div
                className="header-runtime-warning"
                title={
                  sidecarStatus?.protocolCompatible === false
                    ? `Running ptyd protocol ${sidecarStatus?.health?.protocolVersion ?? 'unknown'} does not match expected ${sidecarStatus?.expectedProtocolVersion}`
                    : `Running ptyd ${sidecarStatus?.health?.runtimeFingerprint} is older than disk ${sidecarStatus?.health?.currentFingerprint}`
                }
              >
                stale ptyd
              </div>
              <button
                type="button"
                className="header-tool-btn header-toggle-btn"
                onClick={() => setRestartSidecarModalOpen(true)}
                disabled={restartingSidecar}
                aria-label="Restart stale ptyd"
                title="Restart stale ptyd"
              >
                {restartingSidecar ? '...' : 'restart'}
              </button>
            </>
          )}
          <div className="renderer-toggle" role="group" aria-label="Terminal renderer">
            <button
              type="button"
              className={`renderer-toggle-btn${terminalRenderer === 'xterm' ? ' active' : ''}`}
              onClick={() => switchTerminalRenderer('xterm')}
              aria-pressed={terminalRenderer === 'xterm'}
              aria-label="Use xterm.js renderer"
              title="Use xterm.js"
              disabled={!!switchingRenderer}
            >
              <span className="renderer-toggle-icon">&gt;_</span>
            </button>
            <button
              type="button"
              className={`renderer-toggle-btn${terminalRenderer === 'ghostty' ? ' active' : ''}`}
              onClick={() => switchTerminalRenderer('ghostty')}
              aria-pressed={terminalRenderer === 'ghostty'}
              aria-label="Use Ghostty renderer"
              title="Use Ghostty"
              disabled={!!switchingRenderer}
            >
              <span className="renderer-toggle-icon" aria-hidden="true">👻</span>
            </button>
          </div>
          <button
            type="button"
            className="header-tool-btn"
            onClick={refreshTerminalLayout}
            disabled={!currentKey}
            aria-label="Refresh terminal layout"
            title="Refresh terminal layout"
          >
            ↻
          </button>
          {import.meta.env.DEV && (
            <button
              type="button"
              className={`header-tool-btn header-toggle-btn${studyCopyState !== 'idle' ? ' active' : ''}`}
              onClick={copyCurrentStudy}
              disabled={!currentKey}
              aria-label="Copy remote study report"
              title={
                studyCopyState === 'copied'
                  ? 'Study report copied'
                  : studyCopyState === 'error'
                    ? 'Failed to copy study report'
                    : 'Copy remote study report'
              }
            >
              {studyCopyState === 'copied' ? 'copied' : studyCopyState === 'error' ? 'error' : 'study'}
            </button>
          )}
          <div className="sky-indicator" ref={skyRef} />
          <div className="header-clock" ref={clockRef} />
        </div>
      </header>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      {restartSidecarModalOpen && (
        <Modal
          title="Restart ptyd?"
          message="This will kill the current PTY sessions on this host and start a fresh sidecar. Use it only when stale ptyd needs to be cleared."
          confirmLabel={restartingSidecar ? 'Restarting…' : 'Restart ptyd'}
          danger
          onConfirm={() => { void restartSidecar() }}
          onCancel={() => { if (!restartingSidecar) setRestartSidecarModalOpen(false) }}
        />
      )}

      <Sidebar
        hosts={hosts}
        hostSessions={orderedHostSessions}
        hostStatuses={hostStatuses}
        currentKey={currentKey}
        isOpen={sidebarOpen}
        onNew={(hostId) => newSession(hostId)}
        onAttach={(key) => { attachSession(key); setSidebarOpen(false) }}
        onKill={(key) => setKillTargetKey(key)}
        onRename={renameSession}
        onDuplicate={duplicateSession}
        onReorder={reorderSessions}
        onReorderToEnd={reorderSessionToEnd}
      />

      <main className="main">
        {!currentKey && (
          <div className="no-session">
            <div className="no-session-prompt">no active session</div>
            <button className="no-session-btn" onClick={() => newSession(localHostId)}>new session</button>
          </div>
        )}

        {/* One container per session — always in DOM, stacked absolutely.
            Lazy: xterm.js instance is created only when the session is first viewed. */}
        <div className="terminal-area">
          {terminalEntries.map(({ key }) => {
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
        {currentKey && showScrollToBottomOverlay && (
          <button
            className="scroll-bottom-overlay-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={scrollToBottom}
            title="Scroll to latest output"
            aria-label="Scroll to latest output"
          >
            <span className="scroll-bottom-overlay-icon" aria-hidden>↓</span>
            <span className="scroll-bottom-overlay-label">latest</span>
          </button>
        )}
      </main>

      <MobileToolbar
        currentId={currentKey ? parseKey(currentKey).sessionId : null}
        sendInput={sendInput}
        sendArrowInput={sendArrowInput}
        focusTerminal={() => { if (currentKey) tm.focus(currentKey) }}
        openTextSelection={openTextSelection}
        textSelectionOpen={textSelectionOpen}
      />

      {textSelectionOpen && (
        <SelectionModal
          text={textSelectionSnapshot}
          onRefresh={refreshTextSelectionSnapshot}
          onClose={() => setTextSelectionOpen(false)}
        />
      )}

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
