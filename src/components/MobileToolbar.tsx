import { useCallback, useRef, useState } from 'react'
import { ArrowPad } from './ArrowPad'
import { PasteModal } from './PasteModal'

// ── Hotkey data model ────────────────────────────────────────────────────────

export interface HotkeySlot {
  id: string
  modifiers: ('ctrl' | 'shift' | 'alt')[]
  key: string    // single char like 'c', or 'tab', 'esc', 'enter'
  label: string  // display label e.g. "^C"
}

const DEFAULT_HOTKEYS: HotkeySlot[] = [
  { id: 'hk1', modifiers: ['ctrl'], key: 'c', label: '^C' },
  { id: 'hk2', modifiers: ['ctrl'], key: 'd', label: '^D' },
  { id: 'hk3', modifiers: ['ctrl'], key: 'b', label: '^B' },
]

const HOTKEYS_KEY = 'wt_hotkeys'

function loadHotkeys(): HotkeySlot[] {
  try {
    const stored = JSON.parse(localStorage.getItem(HOTKEYS_KEY) ?? 'null')
    if (Array.isArray(stored) && stored.length > 0) return stored
  } catch { /* ignore */ }
  return DEFAULT_HOTKEYS
}

function saveHotkeys(slots: HotkeySlot[]) {
  localStorage.setItem(HOTKEYS_KEY, JSON.stringify(slots))
}

function computeSequence(slot: HotkeySlot, extraMods?: { ctrl?: boolean; shift?: boolean }): string {
  const mods = new Set(slot.modifiers)
  if (extraMods?.ctrl) mods.add('ctrl')
  if (extraMods?.shift) mods.add('shift')

  const key = slot.key.toLowerCase()

  if (key === 'esc') return '\x1b'
  if (key === 'tab') {
    if (mods.has('shift')) return '\x1b[Z'
    return '\t'
  }
  if (key === 'enter') return '\r'

  if (mods.has('ctrl') && key.length === 1) {
    if (key === '[') return '\x1b'
    const code = key.toUpperCase().charCodeAt(0) - 64
    if (code >= 1 && code <= 26) return String.fromCharCode(code)
  }

  return key
}

// ── Hotkey editor ─────────────────────────────────────────────────────────────

const SPECIAL_KEYS = ['esc', 'tab', 'enter']

interface HotkeyEditorProps {
  slot: HotkeySlot
  onSave: (slot: HotkeySlot) => void
  onDelete: () => void
  onClose: () => void
}

function HotkeyEditor({ slot, onSave, onDelete, onClose }: HotkeyEditorProps) {
  const [mods, setMods] = useState<Set<'ctrl' | 'shift' | 'alt'>>(new Set(slot.modifiers))
  const [key, setKey] = useState(slot.key)
  const [label, setLabel] = useState(slot.label)

  const toggleMod = (m: 'ctrl' | 'shift' | 'alt') =>
    setMods(prev => { const n = new Set(prev); n.has(m) ? n.delete(m) : n.add(m); return n })

  const preview = computeSequence({ ...slot, modifiers: [...mods], key })
    .replace(/\x1b/g, 'ESC ')
    .replace(/\x03/g, '^C')
    .replace(/\x04/g, '^D')
    .replace(/[\x01-\x1a]/g, c => '^' + String.fromCharCode(c.charCodeAt(0) + 64))
    .replace(/\r/g, 'CR')
    .replace(/\t/g, 'TAB')
    .trim()

  function handleSave() {
    onSave({ ...slot, modifiers: [...mods], key, label: label || key })
    onClose()
  }

  return (
    <div className="hotkey-editor-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="hotkey-editor">
        <div className="hotkey-editor-title">edit hotkey</div>

        <div className="hotkey-editor-row">
          {(['ctrl', 'shift', 'alt'] as const).map(m => (
            <button
              key={m}
              className={`hk-mod-btn${mods.has(m) ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleMod(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="hotkey-editor-row">
          <select
            className="hk-key-select"
            value={SPECIAL_KEYS.includes(key) ? key : '__char__'}
            onChange={e => { if (e.target.value !== '__char__') setKey(e.target.value) }}
          >
            <option value="__char__">letter / char</option>
            {SPECIAL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          {!SPECIAL_KEYS.includes(key) && (
            <input
              className="hk-key-input"
              maxLength={1}
              value={key}
              onChange={e => setKey(e.target.value.slice(-1).toLowerCase())}
              placeholder="key"
            />
          )}
        </div>

        <div className="hotkey-editor-row">
          <input
            className="hk-label-input"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="label (e.g. ^C)"
            maxLength={4}
          />
        </div>

        <div className="hotkey-editor-preview">sends: {preview || '?'}</div>

        <div className="hotkey-editor-actions">
          <button className="hk-action-btn danger" onClick={() => { onDelete(); onClose() }}>delete</button>
          <button className="hk-action-btn" onClick={onClose}>cancel</button>
          <button className="hk-action-btn primary" onClick={handleSave}>save</button>
        </div>
      </div>
    </div>
  )
}

// ── Separator ─────────────────────────────────────────────────────────────────

function Sep() {
  return <div className="tb-sep" aria-hidden />
}

// ── Main toolbar ──────────────────────────────────────────────────────────────

interface MobileToolbarProps {
  currentId: string | null
  sendInput: (data: string) => void
  focusTerminal: () => void
  scrollToBottom: () => void
}

export function MobileToolbar({ currentId, sendInput, focusTerminal, scrollToBottom }: MobileToolbarProps) {
  const [ctrlActive, setCtrlActive] = useState(false)
  const [shiftActive, setShiftActive] = useState(false)
  const [arrowPadOpen, setArrowPadOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [hotkeys, setHotkeys] = useState<HotkeySlot[]>(loadHotkeys)
  const [editingSlot, setEditingSlot] = useState<HotkeySlot | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fireHotkey = useCallback((slot: HotkeySlot) => {
    const seq = computeSequence(slot, { ctrl: ctrlActive, shift: shiftActive })
    sendInput(seq)
    setCtrlActive(false)
    setShiftActive(false)
  }, [ctrlActive, shiftActive, sendInput])

  const startLongPress = (slot: HotkeySlot) => {
    longPressRef.current = setTimeout(() => {
      longPressRef.current = null
      setEditingSlot(slot)
    }, 500)
  }

  const cancelLongPress = () => {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null }
  }

  const updateSlot = (updated: HotkeySlot) => {
    const next = hotkeys.map(h => h.id === updated.id ? updated : h)
    setHotkeys(next)
    saveHotkeys(next)
  }

  const deleteSlot = (id: string) => {
    const def = DEFAULT_HOTKEYS.find(h => h.id === id) ?? DEFAULT_HOTKEYS[0]
    const next = hotkeys.map(h => h.id === id ? def : h)
    setHotkeys(next)
    saveHotkeys(next)
  }

  if (!currentId) return null

  return (
    <>
      <div className="mobile-toolbar">

        {/* ── Keyboard: must use onClick so the textarea stays focused after
            the touch sequence ends. onMouseDown prevents the button element
            from stealing focus (which would dismiss the keyboard). ── */}
        <button
          className="tb-btn tb-kbd"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => focusTerminal()}
          title="Show keyboard"
        >
          <span className="tb-icon">⌨</span>
          <span className="tb-label">kbd</span>
        </button>

        <button
          className="tb-btn"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => scrollToBottom()}
          title="Scroll to bottom"
        >
          <span className="tb-icon">↓</span>
        </button>

        <Sep />

        {/* ── Text input keys ── */}
        <button
          className="tb-btn tb-key"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => { e.preventDefault(); sendInput('\x1b') }}
        >
          ESC
        </button>

        <button
          className="tb-btn tb-key"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => { e.preventDefault(); sendInput('\t') }}
        >
          TAB
        </button>

        <button
          className="tb-btn tb-key"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => { e.preventDefault(); sendInput('\r') }}
        >
          ↩
        </button>

        <Sep />

        {/* ── Arrow pad toggle ── */}
        <button
          className={`tb-btn${arrowPadOpen ? ' tb-active' : ''}`}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setArrowPadOpen(o => !o)}
          title="Arrow keys"
        >
          <span className="tb-dpad">⊕</span>
        </button>

        <Sep />

        {/* ── Sticky modifiers ── */}
        <button
          className={`tb-btn tb-mod${ctrlActive ? ' tb-active' : ''}`}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setCtrlActive(o => !o)}
        >
          ^
        </button>

        <button
          className={`tb-btn tb-mod${shiftActive ? ' tb-active' : ''}`}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShiftActive(o => !o)}
        >
          ⇧
        </button>

        <Sep />

        {/* ── Programmable hotkey slots ── */}
        {hotkeys.map(slot => (
          <button
            key={slot.id}
            className={`tb-btn tb-hotkey${(ctrlActive || shiftActive) ? ' tb-primed' : ''}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => { e.preventDefault(); startLongPress(slot) }}
            onPointerUp={(e) => {
              e.preventDefault()
              if (longPressRef.current) { cancelLongPress(); fireHotkey(slot) }
            }}
            onPointerLeave={cancelLongPress}
            onPointerCancel={cancelLongPress}
          >
            {slot.label}
          </button>
        ))}

        <Sep />

        {/* ── Paste ── */}
        <button
          className={`tb-btn tb-paste${pasteOpen ? ' tb-active' : ''}`}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPasteOpen(o => !o)}
          title="Paste"
        >
          paste
        </button>

      </div>

      {arrowPadOpen && (
        <ArrowPad
          onSend={sendInput}
          onClose={() => setArrowPadOpen(false)}
        />
      )}

      {pasteOpen && (
        <PasteModal
          onSend={(text) => sendInput(text)}
          onClose={() => setPasteOpen(false)}
        />
      )}

      {editingSlot && (
        <HotkeyEditor
          slot={editingSlot}
          onSave={updateSlot}
          onDelete={() => deleteSlot(editingSlot.id)}
          onClose={() => setEditingSlot(null)}
        />
      )}
    </>
  )
}
