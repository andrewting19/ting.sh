export interface Host {
  id: string
  name: string
  url: string
  local: boolean
}

export interface Session {
  id: string
  hostId: string
  name: string
  createdAt: number
  clients: number
  cwd: string
}

export type SessionKey = `${string}:${string}`

export function makeKey(hostId: string, sessionId: string): SessionKey {
  return `${hostId}:${sessionId}` as SessionKey
}

export function parseKey(key: SessionKey): { hostId: string; sessionId: string } {
  const idx = key.indexOf(':')
  if (idx <= 0 || idx >= key.length - 1) {
    throw new Error(`Invalid session key: ${key}`)
  }
  return {
    hostId: key.slice(0, idx),
    sessionId: key.slice(idx + 1),
  }
}

export type ConnectionStatus = 'connected' | 'reconnecting'
