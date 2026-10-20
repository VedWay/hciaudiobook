import { describe, expect, it } from 'vitest'
import { isLikelyEcho, isProbablyEcho, ownWords, stripEcho } from './echo'
import { hasNonLatinWords, isCommand, needsInterpreting, parseIntent } from './intents'

describe('parseIntent', () => {
  it.each([
    ['Start reading', { type: 'play' }],
    ['Pause.', { type: 'pause' }],
    ['Resume', { type: 'resume' }],
    ['Continue reading', { type: 'resume' }],
    ['Stop', { type: 'stop' }],
    ['Repeat that', { type: 'repeat' }],
    ['What did you just say?', { type: 'repeat' }],
    ['Ask a question', { type: 'ask' }],
    ['Go back 30 seconds', { type: 'seek', seconds: -30 }],
    ['Go forward thirty seconds', { type: 'seek', seconds: 30 }],
    ['rewind a minute', { type: 'seek', seconds: -60 }],
    ['go back', { type: 'seek', seconds: -30 }],
    ['next section', { type: 'nav', unit: 'section', delta: 1 }],
    ['previous chapter', { type: 'nav', unit: 'chapter', delta: -1 }],
    ['go to chapter three', { type: 'gotoChapter', number: 3 }],
    ['Could you speed up please', { type: 'speed', change: 'up' }],
    ['set speed to 1.5', { type: 'speed', change: 'set', value: 1.5 }],
    ['Where am I?', { type: 'where' }],
    ['bookmark this', { type: 'bookmark' }],
    ['never mind', { type: 'cancel' }],
    ['what can I say', { type: 'help' }],
    ['quiz me', { type: 'quiz' }],
    ["don't resume", { type: 'stayPaused' }],
  ])('%s', (phrase, expected) => {
    expect(parseIntent(phrase)).toEqual(expected)
  })

  // The same request in the many ways people actually say it.
  it.each([
    ['continue', 'resume'], ['Continue.', 'resume'], ['please continue', 'resume'], ['continue please', 'resume'],
    ['okay continue now', 'resume'], ['you can continue', 'resume'], ['shall we continue', 'resume'],
    ['could you please just continue reading the book for me', 'resume'], ['continue with the book', 'resume'],
    ['carry on reading', 'resume'], ['keep on reading', 'resume'], ['proceed', 'resume'], ['unpause', 'resume'],
    ['continue from where I left off', 'resume'], ['pick up where we left off', 'resume'], ['go on then', 'resume'],
    ['alright, back to the book', 'resume'], ['hey can you go ahead and resume', 'resume'], ['move on', 'resume'],
    ['read it out loud', 'play'], ['read aloud', 'play'], ['I want you to start reading', 'play'], ['begin the narration', 'play'],
    ['hang on', 'pause'], ['give me a second', 'pause'], ['wait a minute', 'pause'], ['one sec', 'pause'],
    ['pause for a moment please', 'pause'], ['can you hold on a second', 'pause'], ['just a sec', 'pause'],
    ['stop talking', 'stop'], ['hush', 'stop'],
    ['I have a doubt', 'ask'], ['can I ask you something', 'ask'], ['I have one quick question', 'ask'], ['ask a doubt', 'ask'],
    ['how does this work', 'help'], ['what are my options', 'help'], ['show me the commands', 'help'], ['help me', 'help'],
    ['where am I now', 'where'], ['go back to normal speed', 'speed'], ['say that again please', 'repeat'],
  ])('%s -> %s', (phrase, type) => {
    expect(parseIntent(phrase).type).toBe(type)
  })

  // The essential commands in Hindi, Marathi and Hinglish, in either script: instant, and trusted like "pause".
  it.each([
    ['ruko', 'pause'], ['Ruk jao!', 'pause'], ['रुको', 'pause'], ['एक मिनट रुको', 'pause'], ['थांबा', 'pause'], ['arre zara ruko yaar', 'pause'],
    ['padhna shuru karo', 'play'], ['पढ़ना शुरू करो', 'play'], ['chalu karo na', 'play'], ['वाचा', 'play'],
    ['aage badho', 'resume'], ['जारी रखो', 'resume'], ['पुढे वाचा', 'resume'], ['continue karo please', 'resume'],
    ['phir se bolo', 'repeat'], ['दोबारा बोलो', 'repeat'], ['पुन्हा सांगा', 'repeat'],
    ['thoda dheere', 'speed'], ['तेज़ करो', 'speed'], ['awaaz badhao', 'volume'],
    ['mera ek sawal hai', 'ask'], ['मुझे कुछ पूछना है', 'ask'], ['samajh nahi aaya', 'qa'], ['ek udaharan do', 'qa'],
    ['agla chapter', 'nav'], ['पिछला अध्याय', 'nav'], ['main kahan hoon', 'where'], ['madad karo', 'help'],
    ['haan ji', 'yes'], ['नहीं', 'no'], ['band karo', 'stop'],
  ])('%s -> %s', (phrase, type) => {
    const intent = parseIntent(phrase)
    expect(intent.type).toBe(type)
    expect(isCommand(intent)).toBe(true)
  })

  it('English commands as a Hindi recogniser writes them, and common mishearings', () => {
    for (const [phrase, type] of [['पॉज़', 'pause'], ['कंटिन्यू', 'resume'], ['स्टॉप', 'stop'], ['रिपीट', 'repeat'], ['स्टार्ट रीडिंग', 'play'],
      ['नेक्स्ट चैप्टर', 'nav'], ['paws', 'pause'], ['star reading', 'play'], ['हेल्प', 'help']] as const) {
      expect(parseIntent(phrase).type).toBe(type)
      expect(isCommand(parseIntent(phrase))).toBe(true)
    }
    // Ordinary words the book itself might contain are not commands.
    for (const word of ['stopped', 'pass', 'questions', 'continued']) expect(isCommand(parseIntent(word))).toBe(false)
  })

  it('Indian English phrasings', () => {
    expect(parseIntent('kindly start the reading').type).toBe('play')
    expect(parseIntent('arre do one thing, pause it yaar').type).toBe('pause')
    expect(parseIntent('I am having one doubt').type).toBe('ask')
    expect(needsInterpreting(parseIntent('I am having one doubt'))).toBe(false) // known outright: not left to the model
    expect(parseIntent('repeat once more sir').type).toBe('repeat')
    expect(parseIntent('sounds only')).toMatchObject({ type: 'setting', patch: { verbosity: 'earcons' } })
  })

  it('knows what it cannot read itself and leaves to the language model', () => {
    for (const phrase of ['वर्चुअल मेमोरी क्या होती है', 'thoda sa peeche le chalo na', 'iske baare mein aur batao', 'ok I am ready let us get back to it']) {
      expect(needsInterpreting(parseIntent(phrase))).toBe(true)
    }
    for (const phrase of ['pause', 'रुको', 'yellow theme', 'What is virtual memory?', 'find page faults', 'next chapter']) {
      expect(needsInterpreting(parseIntent(phrase))).toBe(false)
    }
    expect(hasNonLatinWords('रुको')).toBe(true)
    expect(hasNonLatinWords('What’s a “page fault” — exactly?')).toBe(false)
    expect(hasNonLatinWords('café déjà vu')).toBe(false)
  })

  it('still treats real questions as questions, however they open', () => {
    for (const question of ['Can you tell me what a page fault is?', 'Hey, what is virtual memory?', 'I want to know why stacks are last in first out',
      'Could you explain how paging works?']) {
      expect(parseIntent(question).type).toBe('qa')
    }
  })

  it.each([
    ['Explain that', 'explain'],
    ['What does this mean?', 'explain'],
    ['Explain this simply', 'simplify'],
    ['Give me an example', 'example'],
    ['Define this', 'define'],
    ['Summarize this section', 'summarize'],
    ['Tell me more', 'elaborate'],
  ])('%s is a contextual request (%s)', (phrase, intent) => {
    expect(parseIntent(phrase)).toMatchObject({ type: 'qa', intent, question: phrase })
  })

  it('extracts the term from "define <term>" and the scope from "summarize this chapter"', () => {
    expect(parseIntent('Define the page fault')).toMatchObject({ intent: 'define', term: 'page fault' })
    expect(parseIntent('Define this')).toMatchObject({ intent: 'define', term: '' })
    expect(parseIntent('summarize this chapter')).toMatchObject({ intent: 'summarize', scope: 'chapter' })
  })

  it('treats anything shaped like a question as a question, keeping the original wording', () => {
    expect(parseIntent('What is virtual memory?')).toEqual({ type: 'qa', intent: 'question', question: 'What is virtual memory?' })
    expect(parseIntent('why is it needed')).toMatchObject({ type: 'qa', intent: 'question' })
    expect(parseIntent('Can you tell me who proposed the working set model')).toMatchObject({ type: 'qa', intent: 'question' })
  })

  it('does not mistake narration or chatter for a command', () => {
    expect(parseIntent('the program then continues as if nothing had happened').type).toBe('unknown')
    expect(parseIntent('each page table entry also holds a few control bits and a valid bit').type).toBe('unknown')
    expect(isCommand(parseIntent('What is paging?'))).toBe(false)
    expect(isCommand(parseIntent('pause'))).toBe(true)
  })
})

describe('loosely worded requests', () => {
  it.each([
    ['Could you take me back a little', { type: 'seek', seconds: -10 }],
    ['rewind it by about twenty seconds', { type: 'seek', seconds: -20 }],
    ['jump ahead a couple of minutes', { type: 'seek', seconds: 120 }],
    ["Sorry, I didn't catch that", { type: 'repeat' }],
    ['one more time please', { type: 'repeat' }],
    ['hang on a second', { type: 'pause' }],
    ['okay you can keep going now', { type: 'resume' }],
    ["let's go back to the book", { type: 'resume' }],
    ['make it a bit quicker', { type: 'speed', change: 'up' }],
    ["that's too fast for me", { type: 'speed', change: 'down' }],
    ['I can barely hear you', { type: 'volume', change: 'up' }],
    ['move on to the next topic', { type: 'nav', unit: 'section', delta: 1 }],
    ['take me to the previous part', { type: 'nav', unit: 'section', delta: -1 }],
    ['start this chapter from the beginning', { type: 'restartChapter' }],
    ['take me to chapter two', { type: 'gotoChapter', number: 2 }],
    ['what page are we on', { type: 'where' }],
    ['how much is left in this chapter', { type: 'where' }],
    ['remember this spot for me', { type: 'bookmark' }],
    ['take me back to my bookmark', { type: 'gotoBookmark' }],
    ['I have got a doubt here', { type: 'ask' }],
    ['I want a different book', { type: 'library' }],
    ['please do not continue after this', { type: 'stayPaused' }],
  ])('%s', (phrase, expected) => {
    expect(parseIntent(phrase)).toEqual(expected)
  })

  it.each([
    ["I'm lost, that made no sense to me", 'explain'],
    ['Can you say that in plain English', 'simplify'],
    ['could you explain that in simpler words', 'simplify'],
    ['is there a real world analogy for this', 'example'],
    ['what are the key points of this part', 'summarize'],
    ['I would like more detail on that', 'elaborate'],
  ])('%s is about the passage (%s)', (phrase, intent) => {
    expect(parseIntent(phrase)).toMatchObject({ type: 'qa', intent })
  })

  it('still treats real questions as questions, and does not trust loose matches while the narrator speaks', () => {
    expect(parseIntent('What is the difference between paging and segmentation?')).toMatchObject({ type: 'qa', intent: 'question' })
    expect(parseIntent('explain how the page table works')).toMatchObject({ type: 'qa', intent: 'question' })
    expect(parseIntent('what is the meaning of thrashing')).toMatchObject({ type: 'qa', intent: 'define', term: 'thrashing' })
    expect(isCommand(parseIntent('hang on I need to think about that'))).toBe(false)
    expect(parseIntent('hang on I need to think about that').type).toBe('pause')
    expect(isCommand(parseIntent('pause'))).toBe(true)
  })
})

describe('telling the student from the book heard through the loudspeakers', () => {
  const spoken = 'Chapter 3: Virtual Memory What Is Virtual Memory? Virtual memory allows a process to use more memory than is physically available in the main memory.'

  it('a misheard word does not hide an echo, and a real request is not mistaken for one', () => {
    expect(isProbablyEcho('virtual memory allows the process to use mode memory', spoken)).toBe(true)
    expect(isProbablyEcho('than is physically available', spoken)).toBe(true)
    expect(isProbablyEcho('could you take me back a little', spoken)).toBe(false)
    expect(isProbablyEcho('what does physically available mean', spoken)).toBe(false)
    expect(isProbablyEcho('pause', spoken)).toBe(false)
    expect(isProbablyEcho('anything at all', '')).toBe(false)
  })

  it('picks out words spoken over the narrator, but not words the recogniser merely misheard', () => {
    expect(ownWords('than is physically pause available in the', spoken)).toBe('pause')
    expect(ownWords('to use more memory than is physically available in the main memory pause', spoken)).toBe('pause')
    expect(ownWords('a process to use go back more memory than', spoken)).toBe('go back')
    expect(ownWords('stop virtual memory allows a process', spoken)).toBe('stop')
    expect(ownWords('allows the process to use mode memory than is', spoken)).toBe('') // "a" and "more" misheard
    expect(ownWords('virtual memory allows a process to use more memory', spoken)).toBe('')
    expect(ownWords('could you take me back a little', spoken)).toBe('') // not the book at all: judged as a whole
    expect(ownWords('pause', spoken)).toBe('')
  })

  it('removes the narrator\'s words from the front of what the student said, and nothing else', () => {
    expect(stripEcho('available in the main memory what is a page fault', spoken)).toBe('what is a page fault')
    expect(stripEcho('than is physical available in the main memory please go back', spoken)).toBe('please go back') // one misheard word
    expect(stripEcho('what is a page fault', spoken)).toBe('what is a page fault')
    expect(stripEcho('tell me more about the main memory', spoken)).toBe('tell me more about the main memory') // echo-like words at the end
    expect(stripEcho('use more memory than is physically available', spoken)).toBe('use more memory than is physically available') // all echo: left for the echo test
    expect(stripEcho('रुको मुझे एक सवाल पूछना है अभी', spoken)).toBe('रुको मुझे एक सवाल पूछना है अभी')
  })
})

describe('isLikelyEcho', () => {
  const spoken = 'Virtual memory allows a process to use more memory than is physically available in the main memory.'

  it('recognises the microphone picking up the narrator', () => {
    expect(isLikelyEcho('a process to use more memory than is physically', spoken)).toBe(true)
    expect(isLikelyEcho('virtual memory allows the process to use more memory', spoken)).toBe(true)
  })

  it('lets a real question through even when it reuses words from the book', () => {
    expect(isLikelyEcho('what is virtual memory', spoken)).toBe(false)
    expect(isLikelyEcho('why does a process need more memory', spoken)).toBe(false)
  })
})
