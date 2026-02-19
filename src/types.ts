export interface Session {
  id: string
  name: string
  createdAt: number
  clients: number
  cwd: string
}

export type ConnectionStatus = 'connected' | 'reconnecting'
