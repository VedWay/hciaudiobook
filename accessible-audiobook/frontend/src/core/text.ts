/**
 * Matching what was said against titles ("go to the section on page faults",
 * "open operating systems"). Speech recognition drops plurals and small words,
 * so titles are compared by their word stems rather than as exact strings.
 */
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'what', 'how', 'why',
  'about', 'this', 'that', 'it', 'its', 'from', 'by', 'as', 'be',
])

function stem(word: string): string {
  if (/(s|x|z|ch|sh)es$/.test(word) && word.length > 4) return word.slice(0, -2) // processes -> process
  if (/[^s]s$/.test(word) && word.length > 3) return word.slice(0, -1) // pages -> page, faults -> fault
  for (const suffix of ['ing', 'ed']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length)
  }
  return word
}

/** The meaningful words of a phrase, reduced to stems. */
export function stems(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !SMALL_WORDS.has(w)).map(stem)
}

/**
 * How well a spoken phrase matches a title, from 0 to 1: the harmonic mean of
 * "how much of what was said is in the title" and "how much of the title was said".
 */
export function titleScore(said: string, title: string): number {
  const spoken = new Set(stems(said))
  const wanted = new Set(stems(title))
  if (!spoken.size || !wanted.size) return 0
  const shared = [...spoken].filter((word) => wanted.has(word)).length
  if (!shared) return 0
  const precision = shared / spoken.size
  const recall = shared / wanted.size
  return (2 * precision * recall) / (precision + recall)
}

/** The option whose title best matches what was said; earlier options win ties. Undefined if nothing is close. */
export function closest<T>(said: string, options: T[], title: (option: T) => string, threshold = 0.5): T | undefined {
  let best: T | undefined
  let bestScore = 0
  for (const option of options) {
    const score = titleScore(said, title(option))
    if (score > bestScore) [best, bestScore] = [option, score]
  }
  return bestScore >= threshold ? best : undefined
}
