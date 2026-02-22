import { useEffect, useRef } from 'react'

export type ArrowDirection = 'up' | 'down' | 'left' | 'right'

export function getArrowSequence(direction: ArrowDirection, applicationCursorKeysMode = false): string {
  const prefix = applicationCursorKeysMode ? '\x1bO' : '\x1b['
  switch (direction) {
    case 'up': return `${prefix}A`
    case 'down': return `${prefix}B`
    case 'right': return `${prefix}C`
    case 'left': return `${prefix}D`
  }
}

interface ArrowPadProps {
  onSendArrow: (direction: ArrowDirection) => void
  onClose: () => void
}

export function ArrowPad({ onSendArrow, onClose }: ArrowPadProps) {
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

  const ArrowBtn = ({ label, direction, className = '' }: { label: string; direction: ArrowDirection; className?: string }) => (
    <button
      className={`arrow-btn${className ? ' ' + className : ''}`}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => { e.preventDefault(); onSendArrow(direction) }}
    >
      {label}
    </button>
  )

  return (
    <div className="arrow-pad-overlay" ref={ref}>
      <div className="arrow-pad-grid">
        <div className="arrow-pad-row">
          <div className="arrow-pad-empty" />
          <ArrowBtn label="↑" direction="up" />
          <div className="arrow-pad-empty" />
        </div>
        <div className="arrow-pad-row">
          <ArrowBtn label="←" direction="left" />
          <button
            className="arrow-btn arrow-close"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
          >
            ✕
          </button>
          <ArrowBtn label="→" direction="right" />
        </div>
        <div className="arrow-pad-row">
          <div className="arrow-pad-empty" />
          <ArrowBtn label="↓" direction="down" />
          <div className="arrow-pad-empty" />
        </div>
      </div>
    </div>
  )
}
