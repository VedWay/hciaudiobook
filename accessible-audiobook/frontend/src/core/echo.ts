/**
 * With an open microphone and loudspeakers, the recogniser hears the audiobook
 * itself. Three tools deal with that:
 *
 * - isLikelyEcho: strict. Most of the transcript's word triples occur in what the app
 *   just said. Used for questions, which may share words with the book but rarely runs of them.
 * - isProbablyEcho: lenient. Most of its words sit in word pairs the app just said, so a
 *   transcript with a misheard word or two still counts. Used for anything that is not
 *   clearly a command or a question, where wrongly ignoring it costs nothing.
 * - stripEcho: the recogniser often glues the narrator's last words onto the start of what
 *   the student says ("...in the main memory what is virtual memory"). This removes them.
 */
function norm(word: string): string {
  // Letters of any script (with their combining marks): Hindi speech is not "nothing was said".
  return word.toLowerCase().replace(/[^\p{L}\p{M}\p{N}']/gu, '')
}

function words(text: string): string[] {
  return text.split(/\s+/).map(norm).filter(Boolean)
}

export function isLikelyEcho(heard: string, recentlySpoken: string): boolean {
  const h = words(heard)
  if (!h.length) return true
  const spoken = ` ${words(recentlySpoken).join(' ')} `
  const n = Math.min(3, h.length)
  let hits = 0
  let total = 0
  for (let i = 0; i + n <= h.length; i++) {
    total++
    if (spoken.includes(` ${h.slice(i, i + n).join(' ')} `)) hits++
  }
  return hits / total >= 0.5
}

/** For each word: is it part of a pair of neighbouring words that the app just said? */
function echoed(h: string[], recentlySpoken: string): boolean[] {
  const spoken = ` ${words(recentlySpoken).join(' ')} `
  const pair = (i: number) => i >= 0 && i + 1 < h.length && spoken.includes(` ${h[i]} ${h[i + 1]} `)
  return h.map((word, i) => (h.length === 1 ? spoken.includes(` ${word} `) : pair(i) || pair(i - 1)))
}

export function isProbablyEcho(heard: string, recentlySpoken: string): boolean {
  const h = words(heard)
  if (!h.length) return true
  if (!recentlySpoken.trim()) return false
  return echoed(h, recentlySpoken).filter(Boolean).length / h.length >= 0.6
}

/**
 * The words in a transcript that the app did not say: what is left after following the app's own
 * words through it. A command spoken over the narrator lands in the middle of the book's words
 * ("than is physically pause available in the") or at their end; this picks it out. A word the
 * recogniser merely misheard stands in place of one of the app's words and is not counted; an
 * added word is. Returns '' when the transcript does not start with (or contain a run of) the
 * app's words at all - then it is not an echo with something added, and is judged as a whole.
 */
export function ownWords(heard: string, recentlySpoken: string): string {
  const tokens = heard.trim().split(/\s+/)
  const h = tokens.map(norm)
  const s = words(recentlySpoken)
  if (h.length < 3 || !s.length || h.some((word) => !word)) return ''
  let best: { matched: number; own: number[] } = { matched: 0, own: [] }
  for (let first = 0; first < Math.min(2, h.length); first++) { // the student may have got a word in first
    for (let start = 0; start < s.length; start++) {
      if (s[start] !== h[first]) continue
      const own = Array.from({ length: first }, (_, k) => k)
      let i = first
      let j = start
      let matched = 0
      while (i < h.length && j < s.length) {
        if (h[i] === s[j]) {
          matched++
          i++
          j++
        } else if (i + 1 < h.length && h[i + 1] === s[j]) {
          own.push(i++) // an added word: the app's words carry on straight after it
        } else if (i + 2 < h.length && h[i + 2] === s[j] && h[i + 1] !== s[j + 1]) {
          own.push(i, i + 1) // two added words
          i += 2
        } else if (i + 1 < h.length && j + 1 < s.length && h[i + 1] === s[j + 1]) {
          i++ // a misheard word, standing in for one of the app's
          j++
        } else break
      }
      for (; i < h.length; i++) own.push(i) // whatever follows the app's words
      if (matched > best.matched) best = { matched, own }
    }
  }
  if (best.matched < 2) return ''
  return best.own.map((index) => tokens[index]).join(' ')
}

/**
 * What the student said, without the narrator's words the recogniser attached to the front.
 * Only a clear run of at least three echoed words at the very start is removed, and only
 * when at least two words follow it; otherwise the text is returned unchanged.
 */
export function stripEcho(heard: string, recentlySpoken: string): string {
  const tokens = heard.trim().split(/\s+/)
  const h = tokens.map(norm)
  if (h.length < 5 || !recentlySpoken.trim() || h.some((word) => !word)) return heard
  // The longest opening stretch of what was heard that follows one continuous stretch of what the
  // app said, word for word, allowing a single misheard word. Where it ends, the student begins -
  // even if the student's first words happen to be ones the book also used somewhere else.
  const s = words(recentlySpoken)
  let run = 0
  for (let start = 0; start < s.length; start++) {
    if (s[start] !== h[0]) continue
    let i = 0
    let j = start
    let misheard = false
    while (i < h.length && j < s.length) {
      if (h[i] === s[j]) {
        i++
        j++
      } else if (!misheard && i + 1 < h.length && j + 1 < s.length && h[i + 1] === s[j + 1]) {
        misheard = true
        i += 2
        j += 2
      } else break
    }
    run = Math.max(run, i)
  }
  if (run < 3 || h.length - run < 2) return heard
  return tokens.slice(run).join(' ')
}
