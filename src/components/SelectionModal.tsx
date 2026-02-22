import { useLayoutEffect, useRef } from 'react'

interface SelectionModalProps {
  text: string
  onRefresh: () => void
  onClose: () => void
}

export function SelectionModal({ text, onRefresh, onClose }: SelectionModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    try {
      textarea.focus({ preventScroll: true })
    } catch {
      textarea.focus()
    }
  }, [])

  function selectAll() {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
  }

  return (
    <div className="selection-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="selection-modal">
        <div className="selection-modal-header">
          <div className="selection-modal-header-text">
            <div className="selection-modal-title">select text</div>
            <div className="selection-modal-subtitle">native selection mode (scrollback snapshot)</div>
          </div>
          <button className="selection-modal-close" onClick={onClose} aria-label="Close text selection mode">✕</button>
        </div>

        <div className="selection-modal-actions">
          <button className="selection-modal-action" onClick={onRefresh}>Refresh</button>
          <button className="selection-modal-action primary" onClick={selectAll}>Select all</button>
        </div>

        <div className="selection-modal-tip">
          Long-press and drag selection handles to expand. The sheet scrolls while selecting.
        </div>

        <textarea
          ref={textareaRef}
          className="selection-textarea"
          readOnly
          value={text}
          rows={12}
          wrap="off"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
        />
      </div>
    </div>
  )
}
