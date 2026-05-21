import { useLayoutEffect, useRef, useState } from 'react'

export type SelectionScope = 'visible' | 'all'

interface SelectionModalProps {
  visibleText: string
  fullText: string
  onRefresh: () => void
  onClose: () => void
}

type CopyState = 'idle' | 'copied' | 'manual'

export function SelectionModal({ visibleText, fullText, onRefresh, onClose }: SelectionModalProps) {
  const [scope, setScope] = useState<SelectionScope>('visible')
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const text = scope === 'visible' ? visibleText : fullText
  const lineCount = text ? text.split('\n').length : 0
  const charCount = text.length

  // Always show the latest output first — pin the textarea to the bottom on
  // open, on scope toggle, and on refresh (matches what the user just saw in
  // the terminal, which is normally scrolled to bottom).
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.scrollTop = textarea.scrollHeight
  }, [text])

  function flashCopyState(next: Exclude<CopyState, 'idle'>) {
    setCopyState(next)
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => setCopyState('idle'), 1600)
  }

  function selectAll() {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(0, textarea.value.length)
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
    setCopyState('idle')
  }

  function handleScope(next: SelectionScope) {
    if (next === scope) return
    setScope(next)
    setCopyState('idle')
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

        <textarea
          ref={textareaRef}
          className="selection-textarea"
          readOnly
          value={text}
          wrap="soft"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
        />

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
