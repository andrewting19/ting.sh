import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowPad, getArrowSequence, type ArrowDirection } from './ArrowPad'
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

export function computeSequence(slot: HotkeySlot, extraMods?: { ctrl?: boolean; shift?: boolean; alt?: boolean }): string {
  const mods = new Set(slot.modifiers)
  if (extraMods?.ctrl) mods.add('ctrl')
  if (extraMods?.shift) mods.add('shift')
  if (extraMods?.alt) mods.add('alt')

  const key = slot.key.toLowerCase()
  let sequence = ''

  if (key === 'esc') sequence = '\x1b'
  if (key === 'tab') {
    sequence = mods.has('shift') ? '\x1b[Z' : '\t'
  }
  if (key === 'enter') sequence = '\r'

  if (!sequence && mods.has('ctrl') && key.length === 1) {
    if (key === '[') sequence = '\x1b'
    const code = key.toUpperCase().charCodeAt(0) - 64
    if (code >= 1 && code <= 26) sequence = String.fromCharCode(code)
  }

  if (!sequence) sequence = key
  if (mods.has('alt') && sequence) return '\x1b' + sequence
  return sequence
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
  const [lastCharKey, setLastCharKey] = useState(!SPECIAL_KEYS.includes(slot.key) && slot.key ? slot.key : 'a')
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
            onChange={e => {
              const value = e.target.value
              if (value === '__char__') {
                setKey(lastCharKey || 'a')
                return
              }
              setKey(value)
            }}
          >
            <option value="__char__">letter / char</option>
            {SPECIAL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          {!SPECIAL_KEYS.includes(key) && (
            <input
              className="hk-key-input"
              maxLength={1}
              value={key}
              onChange={e => {
                const next = e.target.value.slice(-1).toLowerCase()
                setKey(next)
                if (next) setLastCharKey(next)
              }}
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

// ── Main toolbar ──────────────────────────────────────────────────────────────

interface MobileToolbarProps {
  currentId: string | null
  sendInput: (data: string) => void
  sendArrowInput?: (direction: ArrowDirection) => void
  focusTerminal: () => void
  openTextSelection: () => void
  textSelectionOpen?: boolean
}

export function MobileToolbar({ currentId, sendInput, sendArrowInput, focusTerminal, openTextSelection, textSelectionOpen = false }: MobileToolbarProps) {
  const [macroTrayOpen, setMacroTrayOpen] = useState(false)
  const [ctrlActive, setCtrlActive] = useState(false)
  const [shiftActive, setShiftActive] = useState(false)
  const [arrowPadOpen, setArrowPadOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [hotkeys, setHotkeys] = useState<HotkeySlot[]>(loadHotkeys)
  const [editingSlot, setEditingSlot] = useState<HotkeySlot | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }, [])

  const fireHotkey = useCallback((slot: HotkeySlot) => {
    const seq = computeSequence(slot, { ctrl: ctrlActive, shift: shiftActive })
    sendInput(seq)
    setCtrlActive(false)
    setShiftActive(false)
  }, [ctrlActive, shiftActive, sendInput])

  const startLongPress = (slot: HotkeySlot) => {
    longPressRef.current = setTimeout(() => {
      longPressRef.current = null
      setArrowPadOpen(false)
      setPasteOpen(false)
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

  const toggleArrowPad = () => {
    setMacroTrayOpen(false)
    setPasteOpen(false)
    setEditingSlot(null)
    setArrowPadOpen(o => !o)
  }

  const togglePaste = () => {
    setMacroTrayOpen(false)
    setArrowPadOpen(false)
    setEditingSlot(null)
    setPasteOpen(o => !o)
  }

  const toggleMacroTray = () => {
    setArrowPadOpen(false)
    setPasteOpen(false)
    setEditingSlot(null)
    setMacroTrayOpen(o => !o)
  }

  const openSelection = () => {
    setMacroTrayOpen(false)
    setArrowPadOpen(false)
    setPasteOpen(false)
    setEditingSlot(null)
    openTextSelection()
  }

  if (!currentId) return null

  const modifiersActive = ctrlActive || shiftActive
  const macroSummary = `${ctrlActive ? '^' : ''}${shiftActive ? '⇧' : ''}` || 'macro'

  return (
    <>
      <div className="mobile-toolbar">
        {macroTrayOpen && (
          <div className="mobile-toolbar-tray" id="mobile-macro-tray">
            <div className="mobile-toolbar-tray-grid">
              {/* ── Sticky modifiers ── */}
              <button
                className={`tb-btn tb-mod${ctrlActive ? ' tb-active' : ''}`}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setCtrlActive(o => !o)}
                title="Toggle Ctrl modifier"
              >
                ^
              </button>

              <button
                className={`tb-btn tb-mod${shiftActive ? ' tb-active' : ''}`}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShiftActive(o => !o)}
                title="Toggle Shift modifier"
              >
                ⇧
              </button>

              {/* ── Programmable hotkey slots ── */}
              {hotkeys.map(slot => (
                <button
                  key={slot.id}
                  className={`tb-btn tb-hotkey${modifiersActive ? ' tb-primed' : ''}`}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerDown={(e) => { e.preventDefault(); startLongPress(slot) }}
                  onPointerUp={(e) => {
                    e.preventDefault()
                    if (longPressRef.current) { cancelLongPress(); fireHotkey(slot) }
                  }}
                  onPointerLeave={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  title={`Run macro ${slot.label}`}
                >
                  {slot.label}
                </button>
              ))}

              <button
                className={`tb-btn tb-select${textSelectionOpen ? ' tb-active' : ''}`}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={openSelection}
                title="Select and copy terminal text"
              >
                select
              </button>
            </div>
          </div>
        )}

        <div className="mobile-toolbar-main">
          <button
            className={`tb-btn tb-macro-toggle${macroTrayOpen ? ' tb-active' : ''}${modifiersActive ? ' tb-primed' : ''}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleMacroTray}
            title="Macros and shortcuts"
            aria-expanded={macroTrayOpen}
            aria-controls="mobile-macro-tray"
          >
            <span className="tb-icon">⌘</span>
            <span className="tb-label">{macroSummary}</span>
          </button>

          {/* ── Text input keys ── */}
          <button
            className="tb-btn tb-key"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => { e.preventDefault(); sendInput('\x1b') }}
            title="Escape"
          >
            ESC
          </button>

          <button
            className="tb-btn tb-key"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => { e.preventDefault(); sendInput('\t') }}
            title="Tab"
          >
            TAB
          </button>

          {/* ── Arrow pad toggle ── */}
          <button
            className={`tb-btn${arrowPadOpen ? ' tb-active' : ''}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleArrowPad}
            title="Arrow keys"
          >
            <span className="tb-dpad">⊕</span>
          </button>

          {/* ── Paste ── */}
          <button
            className={`tb-btn tb-paste${pasteOpen ? ' tb-active' : ''}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={togglePaste}
            title="Paste"
          >
            paste
          </button>

          <button
            className="tb-btn tb-key tb-enter"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => { e.preventDefault(); sendInput('\r') }}
            title="Enter"
          >
            ↩
          </button>

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
        </div>
      </div>

      {arrowPadOpen && (
        <ArrowPad
          onSendArrow={(direction) => {
            if (sendArrowInput) {
              sendArrowInput(direction)
              return
            }
            sendInput(getArrowSequence(direction))
          }}
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
