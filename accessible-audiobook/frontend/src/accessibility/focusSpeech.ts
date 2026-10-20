/**
 * Self-voicing for keyboard users who have no screen reader running.
 *
 * The app speaks the book and its own status, but a blind person tabbing through
 * the buttons would otherwise hear nothing about where the focus is. This says
 * the name and kind of each control as the keyboard reaches it ("Ask a
 * question, button, shortcut A"), and its new state when it is changed.
 *
 * It is switched off in screen-reader mode, where the screen reader does this
 * itself, and it never speaks when focus is moved by the app or by the mouse.
 */
import { useEffect, useRef } from 'react'
import { getSettings } from '../core/settings'

type Speaker = (text: string) => void

let override: Speaker | null = null

/**
 * The player speaks through its own controller, which knows how to pause the
 * narrator and carry on from the same word. Pass null to go back to the default.
 */
export function setFocusSpeaker(speaker: Speaker | null): void {
  override = speaker
}

/** The text a listener should hear for a node: no decorative icons, no shortcut badges, no long hints. */
function textOf(node: Element): string {
  const clone = node.cloneNode(true) as Element
  clone.querySelectorAll('[aria-hidden="true"], .kbd, svg, [data-hint]').forEach((hidden) => hidden.remove())
  // Neighbouring elements have no white space between them in the DOM, so join the pieces explicitly.
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
  const pieces: string[] = []
  while (walker.nextNode()) {
    const piece = walker.currentNode.textContent?.replace(/\s+/g, ' ').trim()
    if (piece) pieces.push(piece)
  }
  return pieces.join(' ')
}

/** A longer explanation attached to a control: said after its name and state, as a sentence of its own. */
function hintOf(element: HTMLElement): string {
  const describedBy = element.getAttribute('aria-describedby')
  const described = describedBy ? describedBy.split(/\s+/).map((id) => document.getElementById(id)).filter((el) => el !== null) : []
  const inLabel = 'labels' in element ? [...((element as HTMLInputElement).labels ?? [])].flatMap((label) => [...label.querySelectorAll('[data-hint]')]) : []
  return [...described, ...inLabel].map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
}

function nameOf(element: HTMLElement): string {
  const label = element.getAttribute('aria-label')
  if (label) return label
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)).filter((el) => el !== null).map(textOf).join(' ')
    if (text) return text
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    const fromLabel = element.labels?.[0]
    if (fromLabel) return textOf(fromLabel)
    return element.getAttribute('placeholder') ?? element.name
  }
  return textOf(element)
}

/** What a screen reader would say on reaching this element: its name, what it is, and its state. */
export function describeElement(element: HTMLElement): string {
  const name = nameOf(element)
  const parts: string[] = []
  const tag = element.tagName.toLowerCase()
  const role = element.getAttribute('role')

  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') parts.push(`checkbox, ${element.checked ? 'ticked' : 'not ticked'}`)
    else if (element.type === 'radio') parts.push(`option, ${element.checked ? 'selected' : 'not selected'}`)
    else if (element.type === 'range') parts.push(`slider, ${element.getAttribute('aria-valuetext') ?? element.value}`)
    else if (element.type === 'file') parts.push('file chooser, press Enter to choose a file')
    else if (element.type === 'password') parts.push('password field')
    else parts.push(element.value ? `text field, contains ${element.value}` : 'text field, empty')
  } else if (element instanceof HTMLTextAreaElement) {
    parts.push(element.value ? `text field, contains ${element.value}` : 'text field, empty')
  } else if (element instanceof HTMLSelectElement) {
    parts.push(`list, ${element.selectedOptions[0]?.textContent?.trim() ?? 'nothing'} selected`)
  } else if (tag === 'a') {
    parts.push('link')
  } else if (tag === 'summary') {
    parts.push((element.parentElement as HTMLDetailsElement | null)?.open ? 'expanded, press Enter to close' : 'collapsed, press Enter to open')
  } else if (tag === 'button' || role === 'button') {
    parts.push('button')
  }

  const pressed = element.getAttribute('aria-pressed')
  if (pressed) parts.push(pressed === 'true' ? 'on' : 'off')
  if (element.getAttribute('aria-current')) parts.push('you are here')
  if (element.getAttribute('aria-disabled') === 'true' || (element as HTMLButtonElement).disabled) parts.push('not available')
  const shortcut = element.getAttribute('aria-keyshortcuts')
  if (shortcut) parts.push(`shortcut ${shortcut}`)
  const hint = hintOf(element)
  return [name, ...parts].filter(Boolean).join(', ') + (hint ? `. ${hint}` : '')
}

const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
/** A focus change this soon after a navigation key was caused by that key. */
const KEY_TO_FOCUS_MS = 300

export function useFocusSpeech(defaultSpeaker: Speaker): void {
  const speaker = useRef(defaultSpeaker)
  useEffect(() => { speaker.current = defaultSpeaker })

  useEffect(() => {
    let navigatedAt = -Infinity
    const active = () => {
      const settings = getSettings()
      return settings.speakFocus && !settings.screenReaderMode
    }
    const speak = (text: string) => { if (text) (override ?? speaker.current)(text) }

    const onKeyDown = (event: KeyboardEvent) => {
      if (NAVIGATION_KEYS.has(event.key)) navigatedAt = performance.now()
    }
    let lastGroup: Element | null = null
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target === document.body) return
      // On entering a group of options, say what the group is ("Reading speed") before the option.
      const group = target.closest('fieldset')
      const legend = group && group !== lastGroup ? group.querySelector('legend') : null
      lastGroup = group
      if (!active() || performance.now() - navigatedAt > KEY_TO_FOCUS_MS) return
      speak([legend ? textOf(legend) : '', describeElement(target)].filter(Boolean).join('. '))
    }
    // A control changed without the focus moving: say its new state.
    const onChange = (event: Event) => {
      if (!active()) return
      const target = event.target
      if (target instanceof HTMLInputElement && target.type === 'checkbox') speak(target.checked ? 'ticked' : 'not ticked')
      else if (target instanceof HTMLInputElement && target.type === 'range') speak(target.getAttribute('aria-valuetext') ?? target.value)
      else if (target instanceof HTMLSelectElement) speak(target.selectedOptions[0]?.textContent?.trim() ?? '')
    }
    const onToggle = (event: Event) => {
      const target = event.target
      if (active() && target instanceof HTMLDetailsElement && target.contains(document.activeElement)) speak(target.open ? 'expanded' : 'collapsed')
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('change', onChange)
    document.addEventListener('toggle', onToggle, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('change', onChange)
      document.removeEventListener('toggle', onToggle, true)
    }
  }, [])
}
