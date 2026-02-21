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
    // Small delay so the open-tap doesn't immediately close
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', handler)
    }, 50)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', handler)
    }
  }, [onClose])

  const ArrowBtn = ({ label, seq, className = '' }: { label: string; seq: string; className?: string }) => (
    <button
      className={`arrow-btn${className ? ' ' + className : ''}`}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
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
          <ArrowBtn label="↑" seq="\x1b[A" />
          <div className="arrow-pad-empty" />
        </div>
        <div className="arrow-pad-row">
          <ArrowBtn label="←" seq="\x1b[D" />
          <button
            className="arrow-btn arrow-close"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
          >
            ✕
          </button>
          <ArrowBtn label="→" seq="\x1b[C" />
        </div>
        <div className="arrow-pad-row">
          <div className="arrow-pad-empty" />
          <ArrowBtn label="↓" seq="\x1b[B" />
          <div className="arrow-pad-empty" />
        </div>
      </div>
    </div>
  )
}
