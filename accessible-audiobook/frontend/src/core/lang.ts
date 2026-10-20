/**
 * Which language a piece of text is written in, from its script. Used to give the
 * device voice and the screen reader the right language for non-Latin text; the
 * natural voice does the same job on the server. Latin-script text is assumed to be English.
 */
const SCRIPTS: [lang: string, pattern: RegExp][] = [
  ['ja', /[぀-ヿ]/g], // before Chinese: Japanese mixes kana with Chinese characters
  ['zh', /[一-鿿]/g],
  ['ko', /[가-힯ᄀ-ᇿ]/g],
  ['hi', /[ऀ-ॿ]/g],
  ['bn', /[ঀ-৿]/g],
  ['gu', /[઀-૿]/g],
  ['ta', /[஀-௿]/g],
  ['te', /[ఀ-౿]/g],
  ['kn', /[ಀ-೿]/g],
  ['ml', /[ഀ-ൿ]/g],
  ['ar', /[؀-ۿݐ-ݿ]/g],
  ['ru', /[Ѐ-ӿ]/g],
  ['el', /[Ͱ-Ͽ]/g],
  ['he', /[֐-׿]/g],
  ['th', /[฀-๿]/g],
]

/** A BCP 47 language code when most of the text is in a non-Latin script, otherwise null (English / Latin script). */
export function detectScriptLanguage(text: string): string | null {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (!letters) return null
  for (const [lang, pattern] of SCRIPTS) {
    if ((text.match(pattern)?.length ?? 0) * 3 >= letters) return lang
  }
  return null
}
