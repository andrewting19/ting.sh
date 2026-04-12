export const DEFAULT_SERVER_PORT = 7681

export function resolveServerPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TING_PORT?.trim()
  if (!raw) return DEFAULT_SERVER_PORT
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SERVER_PORT
}
