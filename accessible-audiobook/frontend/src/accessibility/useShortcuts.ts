import { useEffect, useRef } from 'react'

export type ShortcutMap = Record<string, (event: KeyboardEvent) => void>

const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const ACTIVATABLE = 'button, a[href], summary, [role="button"]'

/**
 * Single-key shortcuts for the whole page.
 *
 * Keys are named like "a", "Space", "ArrowLeft", "Shift+ArrowLeft", "?".
 * They never fire while the user is typing in a field, with Ctrl/Alt/Meta held
 * (those belong to the browser and the screen reader), or while a dialog is open.
 * Space and Enter keep their normal meaning on a focused button or link.
 */
export function useShortcuts(shortcuts: ShortcutMap, enabled = true): void {
  const latest = useRef(shortcuts)
  latest.current = shortcuts

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return
      const target = event.target as HTMLElement | null
      if (target?.closest(TYPING) || document.querySelector('dialog[open]')) return
      const base = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLowerCase() : event.key
      if ((base === 'Space' || base === 'Enter') && target?.closest(ACTIVATABLE)) return
      const handler = latest.current[event.shiftKey && base.length > 1 ? `Shift+${base}` : base]
      if (!handler) return
      event.preventDefault()
      if (!event.repeat) handler(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
