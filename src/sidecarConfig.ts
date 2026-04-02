export function resolvePtydHost(): string {
  return process.env.PTYD_HOST?.trim() || '127.0.0.1'
}

export function resolvePtydPort(basePort = parseInt(process.env.PORT ?? '7681', 10)): number {
  const explicit = process.env.PTYD_PORT?.trim()
  if (explicit) {
    const parsed = parseInt(explicit, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return basePort + 100
}

export function getPtydHttpBaseUrl(basePort?: number): string {
  return `http://${resolvePtydHost()}:${resolvePtydPort(basePort)}`
}

export function getPtydWsUrl(basePort?: number): string {
  return `${getPtydHttpBaseUrl(basePort).replace(/^http/, 'ws')}/ws`
}
