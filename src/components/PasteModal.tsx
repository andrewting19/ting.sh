import { useEffect, useRef, useState } from 'react'

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

  useEffect(() => {
    textareaRef.current?.focus()
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
    <div className="paste-modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="paste-modal">
        <div className="paste-modal-header">
          <span className="paste-modal-title">paste / send text</span>
          <button className="paste-modal-close" onPointerDown={onClose}>✕</button>
        </div>

        <textarea
          ref={textareaRef}
          className="paste-textarea"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Type or paste text here…"
          rows={4}
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />

        <button
          className="paste-send-btn"
          onPointerDown={(e) => { e.preventDefault(); handleSend() }}
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
                  onPointerDown={(e) => { e.preventDefault(); setText(item) }}
                >
                  {item.length > 60 ? item.slice(0, 60) + '…' : item}
                </button>
                <button
                  className="paste-history-del"
                  onPointerDown={(e) => { e.preventDefault(); deleteHistory(item) }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
