import { useEffect, useRef } from 'react'

interface ArrowPadProps {
  onSend: (seq: string) => void
  onClose: () => void
}

export function ArrowPad({ onSend, onClose }: ArrowPadProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside tap
  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [onClose])

  const btn = (label: string, seq: string, extra = '') => (
    <button
      className={`arrow-btn${extra ? ' ' + extra : ''}`}
      onPointerDown={(e) => { e.preventDefault(); onSend(seq) }}
    >
      {label}
    </button>
  )

  return (
    <div className="arrow-pad-overlay" ref={ref}>
      <div className="arrow-pad-grid">
        <div className="arrow-pad-row">
          <div className="arrow-pad-empty" />
          {btn('↑', '\x1b[A')}
          <div className="arrow-pad-empty" />
        </div>
        <div className="arrow-pad-row">
          {btn('←', '\x1b[D')}
          <button className="arrow-btn arrow-close" onPointerDown={(e) => { e.preventDefault(); onClose() }}>✕</button>
          {btn('→', '\x1b[C')}
        </div>
        <div className="arrow-pad-row">
          <div className="arrow-pad-empty" />
          {btn('↓', '\x1b[B')}
          <div className="arrow-pad-empty" />
        </div>
      </div>
    </div>
  )
}
