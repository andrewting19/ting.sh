import { useLayoutEffect, useMemo, useRef, useState } from 'react'

export type SelectionScope = 'visible' | 'all'

interface SelectionModalProps {
  visibleText: string
  requestFullText: () => string
  onRefresh: () => void
  onClose: () => void
}

type CopyState = 'idle' | 'copied' | 'manual'

function countLines(s: string): number {
  if (!s) return 0
  let count = 1
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++
  }
  return count
}

export function SelectionModal({ visibleText, requestFullText, onRefresh, onClose }: SelectionModalProps) {
  const [scope, setScope] = useState<SelectionScope>('visible')
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [fullTextLoaded, setFullTextLoaded] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const text = scope === 'visible' ? visibleText : (fullTextLoaded ?? '')

  // Only recompute line/char counts when the underlying text changes —
  // counting newlines in a 10MB string takes ~10ms and we don't want that on
  // every render.
  const { lineCount, charCount } = useMemo(
    () => ({ lineCount: countLines(text), charCount: text.length }),
    [text],
  )

  // Always show the latest output first — pin the scroller to the bottom on
  // open, on scope toggle, and on refresh.
  useLayoutEffect(() => {
    const pre = preRef.current
    if (!pre) return
    pre.scrollTop = pre.scrollHeight
  }, [text])

  function flashCopyState(next: Exclude<CopyState, 'idle'>) {
    setCopyState(next)
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => setCopyState('idle'), 1600)
  }

  function selectAll() {
    const pre = preRef.current
    if (!pre) return
    const range = document.createRange()
    range.selectNodeContents(pre)
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
  }

  async function copyToClipboard() {
    if (!text) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        flashCopyState('copied')
        return
      }
      throw new Error('clipboard API unavailable')
    } catch {
      selectAll()
      try {
        const ok = document.execCommand('copy')
        flashCopyState(ok ? 'copied' : 'manual')
      } catch {
        flashCopyState('manual')
      }
    }
  }

  function handleRefresh() {
    onRefresh()
    setFullTextLoaded(null)
    setCopyState('idle')
  }

  function handleScope(next: SelectionScope) {
    if (next === scope) return
    setScope(next)
    setCopyState('idle')
    if (next === 'all' && fullTextLoaded === null) {
      // Lazy compute the full-scrollback snapshot only when the user asks
      // for it. Costs ~5-15ms for a 10k-line buffer.
      const computed = requestFullText()
      setFullTextLoaded(computed)
    }
  }

  const copyLabel =
    copyState === 'copied' ? '✓ Copied' :
    copyState === 'manual' ? 'Long-press to copy' :
    'Copy'

  return (
    <div
      className="selection-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="selection-modal" role="dialog" aria-label="Copy terminal text">
        <div className="selection-modal-header">
          <span className="selection-modal-title">copy text</span>
          <button
            className="selection-modal-close"
            onClick={onClose}
            aria-label="Close copy text"
          >
            ✕
          </button>
        </div>

        <div className="selection-modal-scope" role="tablist" aria-label="Snapshot scope">
          <button
            role="tab"
            aria-selected={scope === 'visible'}
            className={`selection-scope-btn${scope === 'visible' ? ' active' : ''}`}
            onClick={() => handleScope('visible')}
          >
            visible
          </button>
          <button
            role="tab"
            aria-selected={scope === 'all'}
            className={`selection-scope-btn${scope === 'all' ? ' active' : ''}`}
            onClick={() => handleScope('all')}
          >
            full scrollback
          </button>
          <button
            className="selection-refresh-btn"
            onClick={handleRefresh}
            aria-label="Refresh snapshot"
            title="Refresh snapshot"
          >
            ↻
          </button>
        </div>

        <pre
          ref={preRef}
          className="selection-text"
          spellCheck={false}
          tabIndex={0}
        >{text}</pre>

        <div className="selection-modal-meta">
          {lineCount.toLocaleString()} line{lineCount === 1 ? '' : 's'} · {charCount.toLocaleString()} char{charCount === 1 ? '' : 's'}
        </div>

        <div className="selection-modal-actions">
          <button
            className="selection-action-btn"
            onClick={selectAll}
            disabled={!text}
          >
            Select all
          </button>
          <button
            className={`selection-action-btn primary${copyState !== 'idle' ? ' ' + copyState : ''}`}
            onClick={copyToClipboard}
            disabled={!text}
          >
            {copyLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
