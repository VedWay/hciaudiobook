import { describe, expect, it } from 'vitest'
import { describeElement } from './focusSpeech'

function element(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.querySelector('[data-target]') as HTMLElement
}

describe('describeElement', () => {
  it('names a button without reading out its decorative icon or shortcut badge', () => {
    const button = element('<button data-target aria-keyshortcuts="A"><svg aria-hidden="true"></svg><span>Ask a question</span><span class="kbd" aria-hidden="true">A</span></button>')
    expect(describeElement(button)).toBe('Ask a question, button, shortcut A')
  })

  it('reports toggle state, the current location and unavailable controls', () => {
    expect(describeElement(element('<button data-target aria-pressed="true">Microphone</button>'))).toBe('Microphone, button, on')
    expect(describeElement(element('<button data-target aria-current="location">Page Faults</button>'))).toBe('Page Faults, button, you are here')
    expect(describeElement(element('<button data-target aria-disabled="true">Return to my place</button>'))).toBe('Return to my place, button, not available')
  })

  it('prefers aria-label, then aria-labelledby, then the visible text', () => {
    expect(describeElement(element('<button data-target aria-label="Slower">-</button>'))).toBe('Slower, button')
    expect(describeElement(element('<h2 id="h">Operating Systems</h2><button data-target aria-labelledby="b h" id="b">Continue reading</button>')))
      .toBe('Continue reading Operating Systems, button')
    expect(describeElement(element('<a data-target href="/help">Help</a>'))).toBe('Help, link')
  })

  it('describes form controls with their label and value', () => {
    expect(describeElement(element('<label>Sound cues <input data-target type="checkbox" checked></label>'))).toBe('Sound cues, checkbox, ticked')
    expect(describeElement(element('<label><input data-target type="radio" name="r"> 1.25 times</label>'))).toBe('1.25 times, option, not selected')
    expect(describeElement(element('<label for="q">Type a command</label><input data-target id="q" value="">'))).toBe('Type a command, text field, empty')
    expect(describeElement(element('<label for="v">Volume</label><input data-target id="v" type="range" aria-valuetext="80 percent">'))).toBe('Volume, slider, 80 percent')
    expect(describeElement(element('<label for="s">Voice</label><select data-target id="s"><option>Automatic</option></select>'))).toBe('Voice, list, Automatic selected')
  })

  it('says a hint after the name and state, as its own sentence', () => {
    const toggle = element('<label><input data-target type="checkbox" checked><span><span>Sound cues</span><span data-hint>Short tones for listening and errors.</span></span></label>')
    expect(describeElement(toggle)).toBe('Sound cues, checkbox, ticked. Short tones for listening and errors.')
    const box = element('<label for="c">Type a command <span class="kbd" aria-hidden="true">T</span></label><input data-target id="c" aria-describedby="h"><p id="h">Press Escape to leave the box.</p>')
    expect(describeElement(box)).toBe('Type a command, text field, empty. Press Escape to leave the box.')
  })

  it('keeps words apart when they sit in neighbouring elements', () => {
    expect(describeElement(element('<button data-target><span>Chapter 2: Paging</span><span>page 2</span></button>'))).toBe('Chapter 2: Paging page 2, button')
  })

  it('describes a collapsible section by whether it is open', () => {
    expect(describeElement(element('<details><summary data-target>Notes (2)</summary></details>'))).toBe('Notes (2), collapsed, press Enter to open')
    expect(describeElement(element('<details open><summary data-target>Notes (2)</summary></details>'))).toBe('Notes (2), expanded, press Enter to close')
  })
})
