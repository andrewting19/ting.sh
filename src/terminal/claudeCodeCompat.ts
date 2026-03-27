export const CLAUDE_CODE_COMPAT_STORAGE_KEY = 'wt-claude-code-compat'

const SYNC_OUTPUT_ENTER = '\u001b[?2026h'
const SYNC_OUTPUT_EXIT = '\u001b[?2026l'
const BLANK_ADVANCE = '\r\r\n'

export type ClaudeCodeCompatDecision = 'pass' | 'drop'

export type ClaudeCodeCompatBatchStats = {
  totalBytes: number
  blankAdvanceCount: number
  printableCount: number
  entersSyncOutput: boolean
  exitsSyncOutput: boolean
}

export function resolveClaudeCodeCompat(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(CLAUDE_CODE_COMPAT_STORAGE_KEY) === '1'
}

export function persistClaudeCodeCompat(enabled: boolean): void {
  localStorage.setItem(CLAUDE_CODE_COMPAT_STORAGE_KEY, enabled ? '1' : '0')
}

export function collectClaudeCodeCompatStats(data: Uint8Array): ClaudeCodeCompatBatchStats {
  const text = new TextDecoder().decode(data)
  const blankAdvanceCount = countOccurrences(text, BLANK_ADVANCE)
  let printableCount = 0
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]
    if (byte >= 0x20 && byte <= 0x7e) printableCount++
  }
  return {
    totalBytes: data.length,
    blankAdvanceCount,
    printableCount,
    entersSyncOutput: text.includes(SYNC_OUTPUT_ENTER),
    exitsSyncOutput: text.includes(SYNC_OUTPUT_EXIT),
  }
}

export function shouldDropClaudeCodeResizeSyncBatch(data: Uint8Array): boolean {
  const stats = collectClaudeCodeCompatStats(data)
  if (!stats.entersSyncOutput || !stats.exitsSyncOutput) return false
  if (stats.totalBytes < 1024) return false
  if (stats.blankAdvanceCount < 64) return false
  // Only drop batches overwhelmingly dominated by blank physical line advances.
  return stats.blankAdvanceCount * 4 > stats.printableCount
}

export function findSyncOutputEnter(data: Uint8Array): number {
  return findBytes(data, SYNC_OUTPUT_ENTER_BYTES)
}

export function findSyncOutputExit(data: Uint8Array): number {
  return findBytes(data, SYNC_OUTPUT_EXIT_BYTES)
}

export const SYNC_OUTPUT_ENTER_BYTES = new TextEncoder().encode(SYNC_OUTPUT_ENTER)
export const SYNC_OUTPUT_EXIT_BYTES = new TextEncoder().encode(SYNC_OUTPUT_EXIT)

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const next = text.indexOf(needle, index)
    if (next === -1) return count
    count++
    index = next + needle.length
  }
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}
