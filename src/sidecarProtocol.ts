export const PTYD_PROTOCOL_VERSION = 1

export function parsePtydProtocolVersion(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

export function isPtydProtocolCompatible(value: unknown): boolean {
  return parsePtydProtocolVersion(value) === PTYD_PROTOCOL_VERSION
}
