import { describe, expect, it } from 'vitest'
import { detectScriptLanguage } from './lang'

describe('detectScriptLanguage', () => {
  it.each([
    ['Stacks are last in, first out.', null],
    ['La pila es el último en entrar.', null],
    ['स्टैक में आखिरी आया तत्व सबसे पहले बाहर निकलता है।', 'hi'],
    ['The word नमस्ते means hello.', null],
    ['栈是后进先出的数据结构。', 'zh'],
    ['スタックは後入れ先出しです。', 'ja'],
    ['스택은 후입선출 구조입니다.', 'ko'],
    ['المكدس هو هيكل بيانات.', 'ar'],
    ['Стек — это структура данных.', 'ru'],
    ['123 ... !!!', null],
  ])('%s', (text, lang) => {
    expect(detectScriptLanguage(text)).toBe(lang)
  })
})
