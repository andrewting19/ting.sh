import { useLayoutEffect, useRef, useState } from 'react'

const HISTORY_KEY = 'wt_paste_history'
const MAX_HISTORY = 10

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}

function saveHistory(items: string[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items))
}

interface PasteModalProps {
  onSend: (text: string) => void
  onClose: () => void
}

export function PasteModal({ onSend, onClose }: PasteModalProps) {
  const [text, setText] = useState('')
  const [history, setHistory] = useState<string[]>(loadHistory)
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

  function handleSend() {
    if (!text) return
    onSend(text)
    const next = [text, ...history.filter(h => h !== text)].slice(0, MAX_HISTORY)
    setHistory(next)
    saveHistory(next)
    setText('')
  }

  function deleteHistory(item: string) {
    const next = history.filter(h => h !== item)
    setHistory(next)
    saveHistory(next)
  }

  return (
    <div className="paste-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="paste-modal">
        <div className="paste-modal-header">
          <span className="paste-modal-title">send text</span>
          <button className="paste-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="paste-modal-body">
          <textarea
            ref={textareaRef}
            className="paste-textarea"
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="type or paste text here…"
            rows={4}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />

          <button
            className="paste-send-btn"
            onClick={handleSend}
            disabled={!text}
          >
            Send
          </button>

          {history.length > 0 && (
            <div className="paste-history">
              <div className="paste-history-label">recent</div>
              {history.map((item, i) => (
                <div key={i} className="paste-history-item">
                  <button
                    className="paste-history-text"
                    onClick={() => setText(item)}
                  >
                    {item.length > 60 ? item.slice(0, 60) + '…' : item}
                  </button>
                  <button
                    className="paste-history-del"
                    onClick={() => deleteHistory(item)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
