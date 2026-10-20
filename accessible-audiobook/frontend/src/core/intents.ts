/**
 * The voice / typed command grammar.
 *
 * Deliberately forgiving: each action accepts the several ways people naturally
 * phrase it, so the student does not have to memorise exact wording
 * (recognition over recall). Anything shaped like a question becomes a question.
 */
import type { QAIntent } from '../types'
import type { Settings } from './settings'
import { parseSetting } from './settingsVoice'

export type Page = 'library' | 'settings' | 'help' | 'evaluation'

export type Intent =
  | { type: 'play' | 'pause' | 'resume' | 'stop' | 'repeat' | 'ask' | 'where' | 'help' | 'bookmark' | 'gotoBookmark'
      | 'listBookmarks' | 'replayAnswer' | 'stayPaused' | 'cancel' | 'quiz' | 'library' | 'restartChapter' | 'yes' | 'no' | 'describeSettings'
      | 'readNotes' | 'exportNotes' | 'reviewQuestions' | 'contents' | 'sections' | 'return' }
  /** text / query '' means "ask me what": the app then listens for it. */
  | { type: 'note'; text: string }
  | { type: 'find'; query: string }
  | { type: 'gotoSection'; name: string; unit?: 'section' | 'chapter' }
  | { type: 'gotoPage'; page: number }
  | { type: 'skim'; on: boolean }
  | { type: 'sleep'; seconds?: number; at?: 'section' | 'chapter'; off?: boolean }
  | { type: 'setting'; patch: Partial<Settings>; say: string }
  | { type: 'goto'; page: Page }
  | { type: 'reply'; text: string }
  | { type: 'qa'; intent: QAIntent; question: string; term?: string; scope?: 'section' | 'chapter' }
  | { type: 'seek'; seconds: number }
  | { type: 'nav'; unit: 'sentence' | 'paragraph' | 'section' | 'chapter'; delta: -1 | 0 | 1 }
  | { type: 'gotoChapter'; number: number }
  | { type: 'speed'; change: 'up' | 'down' | 'set'; value?: number }
  | { type: 'volume'; change: 'up' | 'down' }
  | { type: 'spell'; term: string }
  | { type: 'unknown'; text: string }

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90,
}
// Politeness and lead-ins that carry no meaning: "hey, could you please just go ahead and ...".
// Longer alternatives come first, so "i want you to" is not cut down to "i want".
const FILLER = /^(please|hey there|hey|hi|hello|ok|okay|alright|all right|well|um|uh|so|now|kindly|arre|arey|accha|achha|do one thing|reader|computer|assistant|can you|could you|would you mind|would you|will you|do you mind|is it possible to|i want to know|i need to know|i would like to know|i'd like to know|i was wondering|i am wondering|i'm wondering|i wonder|do you know|i want you to|i need you to|i would like you to|i'd like you to|i want to|i need to|i would like to|i'd like to|i wanna|i want|go ahead and|you can|you may|we can|shall we|can we|could we|why don't you|let's|let us)\s+/
const TRAILER = /\s+(please|thanks|thank you|for me|right now|now|then|if you can|if possible|okay|ok|na|yaar|ji|sir|madam|bhai|boss)$/
const DEICTIC = /^(this|that|it|this term|that term|this word|that word|the term|the word)$/
const DEFAULT_VOICE_SEEK_SECONDS = 30

/**
 * The essential commands in Hindi, Marathi and Hinglish, in either script, mapped onto the English
 * phrase the grammar knows. They work instantly and offline; anything longer or less common in
 * these languages is worked out by the language model (see the controller's `converse`).
 */
const INDIAN_ALIASES: [RegExp, string][] = [
  // English commands as a Hindi or Marathi recogniser writes them down, and as an English one mishears them.
  // Only spellings that are not ordinary words: "stopped" or "pass" could be the book itself.
  [/^(पॉज़|पॉज|पौज|पौज़|पाज़|पॉस|paws|pauze|paus)$/, 'pause'],
  [/^(कंटिन्यू|कन्टिन्यू|कंटीन्यू|कंटिन्यु|कॉन्टिन्यू|continu|can tinue|con tinue)$/, 'continue'],
  [/^(रिज़्यूम|रिज्यूम|रिज़ूम|रेज़्यूम|रिझ्यूम|resum|re zoom)$/, 'resume'],
  [/^(स्टॉप|स्टाप|स्टोप|stopp)$/, 'stop'],
  [/^(स्टार्ट|स्टार्ट रीडिंग|स्टार्ट करो|प्ले|start reeding|star reading|start riding)$/, 'start reading'],
  [/^(कंटिन्यू रीडिंग|कन्टिन्यू रीडिंग|continue reeding|continue riding)$/, 'continue reading'],
  [/^(रिपीट|रिपीट दैट|रीपीट|repeate|re peat)$/, 'repeat'],
  [/^(हेल्प|हैल्प)$/, 'help'],
  [/^(नेक्स्ट चैप्टर|नेक्स्ट चॅप्टर)$/, 'next chapter'],
  [/^(प्रीवियस चैप्टर)$/, 'previous chapter'],
  [/^(नेक्स्ट सेक्शन)$/, 'next section'],
  [/^(फास्टर|फ़ास्टर|फास्ट)$/, 'faster'],
  [/^(स्लोअर|स्लो|स्लोवर)$/, 'slower'],
  [/^(कैंसिल|कैन्सल|कॅन्सल)$/, 'cancel'],
  [/^(गो बैक|गो बॅक)$/, 'go back'],
  [/^(आस्क|आस्क अ क्वेश्चन|क्वेश्चन)$/, 'ask a question'],
  [/^(ruko|ruk jao|ruk ja|rukiye|ruk jaiye|thehro|thahro|ek minute|ek minute ruko|ek second|bas|bas karo|रुको|रुक जाओ|रुकिए|ठहरो|बस|बस करो|एक मिनट|एक मिनट रुको|थांब|थांबा|एक मिनिट)$/, 'pause'],
  [/^(band karo|band kar do|chup|chup raho|बंद करो|बंद कर दो|चुप|चुप रहो|बंद करा)$/, 'stop'],
  [/^(padho|padhiye|padhna shuru karo|padhna chalu karo|shuru karo|chalu karo|chalao|start karo|kitab padho|पढ़ो|पढ़िए|पढ़ना शुरू करो|शुरू करो|चालू करो|चलाओ|किताब पढ़ो|वाचा|वाचायला सुरुवात करा|सुरू करा|सुरु करा)$/, 'start reading'],
  [/^(aage badho|aage padho|aage chalo|jaari rakho|jari rakho|chalte raho|continue karo|padhte raho|wapas shuru karo|आगे बढ़ो|आगे पढ़ो|आगे चलो|जारी रखो|चलते रहो|पढ़ते रहो|पुढे चला|पुढे वाचा|चालू ठेवा)$/, 'continue reading'],
  [/^(phir se bolo|fir se bolo|dobara bolo|phir se|fir se|dobara|ek baar aur|ek baar phir|kya bola|kya kaha|फिर से बोलो|दोबारा बोलो|फिर से|दोबारा|एक बार और|क्या कहा|क्या बोला|पुन्हा सांगा|परत सांगा|पुन्हा)$/, 'repeat that'],
  [/^(tez|tez karo|tez padho|jaldi|jaldi padho|thoda tez|तेज़|तेज|तेज़ करो|तेज करो|जल्दी|जल्दी पढ़ो|थोड़ा तेज़|जलद|वेगाने)$/, 'faster'],
  [/^(dheere|dheere dheere|dheere padho|dheere bolo|thoda dheere|aaram se|धीरे|धीरे धीरे|धीरे पढ़ो|धीरे बोलो|थोड़ा धीरे|आराम से|हळू|हळू वाचा)$/, 'slower'],
  [/^(awaaz badhao|awaz badhao|zor se|zor se bolo|आवाज़ बढ़ाओ|आवाज बढ़ाओ|ज़ोर से|जोर से|ज़ोर से बोलो|आवाज वाढवा|मोठ्याने)$/, 'louder'],
  [/^(awaaz kam karo|awaz kam karo|dheemi awaaz|आवाज़ कम करो|आवाज कम करो|आवाज कमी करा)$/, 'quieter'],
  [/^(sawal|sawaal|ek sawal hai|mera ek sawal hai|mujhe kuch poochna hai|mujhe kuch puchna hai|sawal poochna hai|ek doubt hai|सवाल|एक सवाल है|मेरा एक सवाल है|मुझे कुछ पूछना है|प्रश्न|एक प्रश्न आहे|मला एक प्रश्न आहे)$/, 'ask a question'],
  [/^(samjhao|samjha do|samjhaiye|iska matlab kya hai|matlab kya hai|iska matlab samjhao|samajh nahi aaya|samajh nahin aaya|समझाओ|समझा दो|समझाइए|इसका मतलब क्या है|मतलब क्या है|समझ नहीं आया|समजावून सांगा|याचा अर्थ काय|समजले नाही)$/, 'explain that'],
  [/^(aasan shabdon mein samjhao|asaan bhasha mein samjhao|simple mein samjhao|आसान शब्दों में समझाओ|आसान भाषा में समझाओ|सोप्या भाषेत सांगा)$/, 'explain this simply'],
  [/^(udaharan do|ek udaharan do|example do|ek example do|उदाहरण दो|एक उदाहरण दो|उदाहरण द्या)$/, 'give me an example'],
  [/^(saransh|saransh batao|summary do|sankshep mein batao|सारांश|सारांश बताओ|संक्षेप में बताओ|सारांश सांगा)$/, 'summarize this section'],
  [/^(madad|madad karo|meri madad karo|मदद|मदद करो|मेरी मदद करो|मदत|मदत करा)$/, 'help'],
  [/^(main kahan hoon|mai kahan hu|kahan hoon|kaun sa chapter hai|मैं कहाँ हूँ|मैं कहां हूं|कहाँ हूँ|कौन सा अध्याय है|मी कुठे आहे)$/, 'where am i'],
  [/^(agla chapter|agla adhyay|अगला अध्याय|अगला चैप्टर|पुढचा धडा|पुढील धडा)$/, 'next chapter'],
  [/^(pichla chapter|pichhla chapter|पिछला अध्याय|पिछला चैप्टर|मागचा धडा|मागील धडा)$/, 'previous chapter'],
  [/^(agla section|agla bhag|agla hissa|अगला भाग|अगला हिस्सा|पुढचा भाग)$/, 'next section'],
  [/^(pichla section|pichla bhag|पिछला भाग|पिछला हिस्सा|मागचा भाग)$/, 'previous section'],
  [/^(peeche jao|piche jao|thoda peeche|wapas jao|पीछे जाओ|थोड़ा पीछे|वापस जाओ|मागे जा|थोडे मागे)$/, 'go back'],
  [/^(aage jao|thoda aage|आगे जाओ|थोड़ा आगे|पुढे जा|थोडे पुढे)$/, 'go forward'],
  [/^(kitab band karo|meri kitabein|meri kitabe|kitabein dikhao|किताब बंद करो|मेरी किताबें|किताबें दिखाओ|पुस्तक बंद करा|माझी पुस्तके)$/, 'go to my books'],
  [/^(haan|ji haan|ji|theek hai|thik hai|हाँ|हां|जी हाँ|जी|ठीक है|हो|होय)$/, 'yes'],
  [/^(nahi|nahin|ji nahi|nahi chahiye|नहीं|जी नहीं|नहीं चाहिए|नाही|नको)$/, 'no'],
  [/^(rehne do|chhodo|jaane do|रहने दो|छोड़ो|जाने दो|राहू दे|सोडा)$/, 'never mind'],
]
/** Courtesy words around a Hindi / Marathi / Hinglish command. */
const INDIAN_EDGES = /^(zara|jara|please|kripya|arre|are|accha|achha|theek hai|ज़रा|जरा|कृपया|अरे|अच्छा|कृपा करून)\s+|\s+(please|na|yaar|ji|bhai|sir|madam|didi|bhaiya|abhi|ना|यार|जी|भाई|अभी|प्लीज़|प्लीज|ना रे|बरं)$/

/** The English command for a Hindi / Marathi / Hinglish one, or the text unchanged. */
export function translateIndianCommand(text: string): string {
  let t = text.toLowerCase().replace(/[.,!?।"'‘’“”]/g, ' ').replace(/\s+/g, ' ').trim()
  for (let previous = ''; previous !== t;) {
    previous = t
    t = t.replace(INDIAN_EDGES, '').trim()
  }
  for (const [pattern, command] of INDIAN_ALIASES) if (pattern.test(t)) return command
  return text
}

/** Is this written (at least partly) outside the Latin alphabet? The English grammar cannot read it; the language model can. */
export function hasNonLatinWords(text: string): boolean {
  return /[^\u0000-ɏ -⁯]/.test(text)
}

export function normalize(text: string): string {
  let t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9\s.']/g, ' ')
    .replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()
  for (let previous = ''; previous !== t;) {
    previous = t
    t = t.replace(FILLER, '').replace(TRAILER, '')
  }
  return t
}

export function parseNumber(text: string): number | null {
  const t = text.trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  return NUMBER_WORDS[t] ?? null
}

const TIME_UNIT = /(seconds?|secs?|minutes?|mins?|hours?|hrs?)/

/** "30 seconds", "a minute", "two minutes", "half an hour" -> seconds. A bare number counts as seconds. */
function parseDuration(text: string | undefined): number | null {
  if (!text) return null
  const t = text.trim()
  const half = /^half an? (minute|hour)$/.exec(t)
  if (half) return half[1] === 'hour' ? 1800 : 30
  const match = new RegExp(`^(.+?)\\s*${TIME_UNIT.source}?$`).exec(t)
  const amount = match ? parseNumber(match[1]) : null
  if (amount === null) return null
  const unit = match![2] ?? ''
  return amount * (unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1)
}

/** For a sleep timer a bare number means minutes: "sleep timer fifteen". */
function parseTimer(text: string | undefined): number | null {
  const seconds = parseDuration(text)
  return seconds === null ? null : TIME_UNIT.test(text!) ? seconds : seconds * 60
}

/**
 * The optional tag: 'orient' and 'passage' mark loose rules that also apply to
 * question-shaped phrases; 'free' marks exact rules that capture free text ("find ...",
 * "note that ..."), which the narrator's own words could match - see isCommand.
 */
type Rule = [RegExp, (match: RegExpExecArray, original: string) => Intent | null, ('orient' | 'passage' | 'free')?]

/** Words after "go to ..." that belong to other commands, not to a section title. */
const NOT_A_TITLE = /^(the )?(next|previous|last|prior|start|beginning|end|book|audiobook|story|text|reading)\b|\b(bookmarks?|library|books|settings|help|my place|my spot|where i|sleep|bed)\b|^(the )?(normal|regular|usual|default|original) (speed|pace|rate|volume)$/

const simple = (type: Extract<Intent, { type: string }>['type']) => () => ({ type }) as Intent
const qa = (intent: QAIntent, extra: Partial<Extract<Intent, { type: 'qa' }>> = {}) =>
  (_: RegExpExecArray, original: string): Intent => ({ type: 'qa', intent, question: original, ...extra })

const RULES: Rule[] = [
  [/^((start|begin)( reading| the book| the audiobook| playing| the reading| the narration)?|play( the book| it)?|read( to me| it| the book| aloud| out loud| it out| it aloud| it to me| it out loud)?)$/, simple('play')],
  [/^(pause|hold on|hang on|hold up|wait|one (moment|second|sec|minute)|just a (moment|second|sec|minute)|(wait|give me|hold on|hang on) a (moment|second|sec|minute)|pause (the )?(book|reading|audiobook)|pause it|(pause|stop) for a (moment|second|sec|minute))$/, simple('pause')],
  [/^(resume|continue|proceed|unpause|un pause|keep going|go on|carry on|go ahead|read on|move on|(continue|keep|keep on|resume|carry on|go on) reading|(resume|continue|carry on|go on)( with)? (the |my )?(book|audiobook|reading|story|chapter)|back to (the |my )?(book|reading)|(continue|resume|carry on|pick up)( reading)?( from)? (here|where (i|we) (left off|stopped|were|was)))$/, simple('resume')],
  [/^(stop|stop reading|stop the book|stop it|stop talking|be quiet|quiet|silence|shush|hush)$/, simple('stop')],
  [/^((repeat|replay|say) the answer( again)?|answer again|replay answer)$/, simple('replayAnswer')],
  [/^(repeat|repeat that|say that again|say it again|read that again|what did you (just )?say|what was that|come again|pardon|sorry what|again|repeat the (last )?sentence)$/, simple('repeat')],
  [/^(ask( you)?( a| one)?( quick)? (question|doubt|something)|question|doubt|(i have|i am having|i'm having|i've got|i got|there is|i had)( a| one| some)?( quick| small)? (question|doubt|query|questions|doubts)|i have something to ask|i want to ask (a question|something)|ask|let me ask( a question| something)?|can i ask( you)?( a question| something)?)$/, simple('ask')],
  [/^(stay paused|(don't|do not) (resume|continue|start again)|stay here|keep it paused)$/, simple('stayPaused')],
  [/^(cancel|never ?mind|forget it|no question)$/, simple('cancel')],
  [/^(quiz me|test me|ask me a question|give me a quiz|quiz)$/, simple('quiz')],
  [/^(help|help me|what can i (say|do|ask)|what do i say|commands|(list|show|tell me|read)( me)?( the)? commands|what are (the commands|my options)|options|what can you do|how does this work|how do i use this)$/, simple('help')],
  [/^(where am i|where are we|(what|which) (chapter|section|page)( is this| am i on| are we on)?|what am i reading|how (much|far)( is)? left|how far am i)$/, simple('where')],
  [/^(bookmark( this| that| here)?|add( a)? bookmark|save (this|my) (place|position|spot)|mark this)$/, simple('bookmark')],
  [/^(go to|open|jump to) (my |the )?(last )?bookmark$/, simple('gotoBookmark')],
  [/^(list|read)( my)? bookmarks$/, simple('listBookmarks')],
  [/^((go to|open|back to)( the| my)? (library|books|bookshelf)|close( the)? book|my books)$/, simple('library')],
  [/^(?:go|take me|bring me|switch|head|navigate)?(?: back)?(?: to)?(?: the| my)? ?(settings|preferences|help|home|library|evaluation|dashboard)(?: page| screen| dashboard)?$|^(?:open|show)(?: me)?(?: the| my)? (settings|preferences|help|evaluation|dashboard)(?: page| screen| dashboard)?$/,
    (m) => {
      const word = m[1] ?? m[2]
      const page: Page = word === 'preferences' ? 'settings' : word === 'home' ? 'library' : word === 'dashboard' ? 'evaluation' : word as Page
      return { type: 'goto', page }
    }],
  [/^((what are|read|tell me|list|describe)( me)?( my| the| current)* settings|my settings)$/, simple('describeSettings')],
  [/^(no|nope|no thanks|no thank you|that's all|that is all|i'm good|nothing else)$/, simple('no')],
  [/^(yes|yeah|yep|sure|yes please)$/, simple('yes')],

  // Requests about "whatever I was just listening to".
  [/^(explain (this|that|it) (simply|more simply|in simple(r)? (words|terms))|explain simply|simplify( (this|that|it))?|(make|say) (it|that|this) simpler|simpler|in simple(r)? (words|terms)|explain (it|this|that) like i'm (five|a beginner)|i still (don't|do not) (understand|get it))$/, qa('simplify')],
  [/^(explain( (this|that|it))?|what does (this|that|it) mean|what do you mean|i (don't|do not|didn't|did not) (understand|get (it|that|this))( (this|that|it))?|i'm confused|i am confused|what is (this|that)|what's that)$/, qa('explain')],
  [/^(((give|show|tell) me )?(an |another |one )?example( of (this|that|it))?|(can|could|may) i (have|get) an example|for example)$/, qa('example')],
  [/^(tell me more|more details?|elaborate|go deeper|explain (more|further)|say more)( about (this|that|it))?$/, qa('elaborate')],
  [/^(summari[sz]e|summary|recap|give me a (summary|recap)|sum up)( (of )?(this |the |that )?(section|chapter|part))?( so far)?$/,
    (m, original) => ({ type: 'qa', intent: 'summarize', question: original, scope: m[0].includes('chapter') ? 'chapter' : 'section' })],
  [/^what have i (just )?(learned|heard)( so far)?$/, qa('summarize', { scope: 'section' })],
  [/^(define|definition of|what is the (definition|meaning) of|what's the (definition|meaning) of|meaning of) (.+)$/,
    (m, original) => {
      const term = m[m.length - 1].replace(/^(the|a|an) /, '')
      return { type: 'qa', intent: 'define', question: original, term: DEICTIC.test(term) ? '' : term }
    }, 'free'],
  [/^spell (.+)$/, (m) => ({ type: 'spell', term: DEICTIC.test(m[1]) ? '' : m[1] }), 'free'],

  // Study tools: notes, the table of contents, finding a passage, skimming, the sleep timer.
  [/^((take|make|add|save|write|record|leave)( down)?( a| another| me a)? note|note (this|that)|note down|(new|add) note)$/, () => ({ type: 'note', text: '' })],
  [/^(?:take a note|make a note|add a note|write a note|note down|note)(?: that| saying| this)?:? (.{3,})$/, (m, original) => {
    // Keep the student's own wording and capitals: only the "note that" lead-in is removed.
    const text = original.replace(/^.*?\bnote(?: down)?(?: that| saying| this)?[:,]?\s+/i, '')
    return { type: 'note', text: text || m[1] }
  }, 'free'],
  [/^((read|list|show|tell me|what are)( me)?( my| the)? notes|my notes)$/, simple('readNotes')],
  [/^(export|download|save|get)( me)?( my| the)?( study)? (notes|study sheet|study notes|notes and questions)$/, simple('exportNotes')],
  [/^(what did i ask|what have i asked|(review|read|list)( me)?( my)? questions|my questions)$/, simple('reviewQuestions')],
  [/^(?:read|tell me|show|list|what is|what's|what are)?(?: me)?(?: the)? ?(?:table of contents|contents|chapter list|list of chapters|chapters)$|^(?:what|which) chapters (?:are there|does (?:it|this book|the book) have)$|^what(?:'s| is) in (?:this|the) book$/, simple('contents')],
  [/^(?:what|which) sections (?:are there|are in (?:this|the) chapter|does (?:this|the) chapter have)$|^(?:list|read|tell me)(?: me)?(?: the)? sections(?: (?:in|of) (?:this|the) chapter)?$|^what(?:'s| is) in (?:this|the) chapter$/, simple('sections')],
  [/^(?:go|take me|bring me|jump|return|get)?(?: me)?(?: back)?(?: to)? ?(?:where i was|my place|my spot|where i left off|where i stopped|my previous place|the previous place|where i came from)$|^return$/, simple('return')],
  [/^(skim|skim (this|the|through)( the| this)?( section| chapter| book| part)?|skim ahead|skim mode( on)?|start skimming|skim read(ing)?|just the first sentences?)$/, () => ({ type: 'skim', on: true })],
  [/^(stop skimming|skim(ming)?( mode)? off|read normally|normal reading|read everything|read (it|this) (all|in full|properly)|read (this|that) (part|paragraph|bit|one)|read in full|full reading)$/, () => ({ type: 'skim', on: false })],
  [/^(?:cancel|stop|clear|turn off|remove|no)(?: the| my)? (?:sleep )?timer$|^(?:sleep )?timer off$/, () => ({ type: 'sleep', off: true })],
  [/^(?:stop|pause|sleep)(?: reading)? (?:at the end of|after) (?:the |this )?(section|chapter)$/, (m) => ({ type: 'sleep', at: m[1] as 'section' })],
  [/^(?:set (?:a |the )?)?(?:sleep )?timer(?: for| to| of)? (.+)$|^(?:stop|pause|sleep)(?: reading)? (?:in|after) (.+)$|^sleep (?:in|for) (.+)$/, (m) => {
    const seconds = parseTimer(m[1] ?? m[2] ?? m[3])
    return seconds === null ? null : { type: 'sleep', seconds }
  }],
  [/^(find|search|(find|search|look for) (something|it)|search (the|this) book)$/, () => ({ type: 'find', query: '' })],
  [/^(?:find|search(?: for)?|look for|look up)(?: me)?(?: the)?(?: part| section| place| bit| passage)?(?: (?:where|that|which) (?:it |the book |they |he |she )?(?:talks?|says?|explains?|mentions?|discuss(?:es)?|covers?|defines?|describes?))?(?: about| on| for| of)? (.+)$/,
    (m) => ({ type: 'find', query: m[1] }), 'free'],
  [/^where (?:does|did|do) (?:it|the book|they|this book) (?:talk|say|explain|mention|discuss|cover|define|describe)s?(?: about| on)? (.+)$/, (m) => ({ type: 'find', query: m[1] }), 'free'],
  [/^where (?:is|are|was) (.+?) (?:explained|defined|mentioned|discussed|covered|introduced|described)$/, (m) => ({ type: 'find', query: m[1] }), 'free'],

  // Navigation.
  [/^(?:go |skip |jump |move )?(?:back|backwards?|rewind)(?: by)?(?: (.+))?$/, (m) => {
    const seconds = m[1] ? parseDuration(m[1]) : DEFAULT_VOICE_SEEK_SECONDS
    return seconds === null ? null : { type: 'seek', seconds: -seconds }
  }],
  [/^(?:go |skip |jump |move |fast )?(?:forwards?|ahead)(?: by)?(?: (.+))?$/, (m) => {
    const seconds = m[1] ? parseDuration(m[1]) : DEFAULT_VOICE_SEEK_SECONDS
    return seconds === null ? null : { type: 'seek', seconds }
  }],
  [/^(?:go to (?:the )?|skip to (?:the )?)?(next|previous|last|prior) (sentence|paragraph|section|chapter)$/,
    (m) => ({ type: 'nav', unit: m[2] as 'sentence', delta: m[1] === 'next' ? 1 : -1 })],
  [/^skip (?:this |the )?(sentence|paragraph|section|chapter)$/, (m) => ({ type: 'nav', unit: m[1] as 'sentence', delta: 1 })],
  [/^(restart|repeat|start) (the |this )?(section|paragraph)( again| over)?$/, (m) => ({ type: 'nav', unit: m[3] as 'section', delta: 0 })],
  [/^((restart|start) (the |this )?chapter( again| over)?|(go to|from) the (beginning|start) of (the |this )?chapter)$/, simple('restartChapter')],
  [/^(?:go to|open|jump to|read) chapter (\w+)$/, (m) => {
    const number = parseNumber(m[1])
    return number === null ? null : { type: 'gotoChapter', number }
  }],
  [/^(?:(?:go|jump|skip|take me|turn)(?: to)?(?: the)?|open) page (?:number )?(\w+)$|^page (\d+)$/, (m) => {
    const page = parseNumber(m[1] ?? m[2])
    return page === null ? null : { type: 'gotoPage', page }
  }],
  // "Go to the section on page faults": a heading by name, or failing that, wherever the book covers it.
  [/^(?:go|take me|jump|skip|move|bring me|get me)(?: back)? to (?:the )?(?:(part|section|bit|place|chapter|topic|heading) )?(?:(?:about|on|called|named|titled|for|of) |(?:where|that) (?:it |the book )?(?:talks?|explains?|says?|covers?|discuss(?:es)?|defines?|mentions?)(?: about)? )?(.+)$/,
    (m) => {
      if (NOT_A_TITLE.test(m[2])) return null
      const number = m[1] === 'chapter' ? parseNumber(m[2]) : null
      if (number !== null) return { type: 'gotoChapter', number }
      return { type: 'gotoSection', name: m[2].replace(/ (section|part|chapter)$/, ''), unit: m[1] === 'chapter' ? 'chapter' : 'section' }
    }, 'free'],
  [/^(?:open|read|start|play) (?:the )?(section|part|chapter|topic) (?:about |on |called |named |titled )?(.+)$/,
    (m) => (NOT_A_TITLE.test(m[2]) ? null : { type: 'gotoSection', name: m[2], unit: m[1] === 'chapter' ? 'chapter' : 'section' }), 'free'],

  // Voice settings.
  [/^(faster|speed up|read faster|go faster|increase( the)? speed)$/, () => ({ type: 'speed', change: 'up' })],
  [/^(slower|slow down|read slower|go slower|decrease( the)? speed)$/, () => ({ type: 'speed', change: 'down' })],
  [/^(normal speed|reset speed)$/, () => ({ type: 'speed', change: 'set', value: 1 })],
  [/^(?:set )?speed (?:to )?(\d(?:\.\d+)?|[a-z]+)(?: x| times)?$/, (m) => {
    const value = parseNumber(m[1])
    return value === null ? null : { type: 'speed', change: 'set', value }
  }],
  [/^(louder|volume up|speak up|(increase|raise)( the)? volume)$/, () => ({ type: 'volume', change: 'up' })],
  [/^(quieter|softer|volume down|(decrease|lower)( the)? volume)$/, () => ({ type: 'volume', change: 'down' })],
]

const QUESTION_START = /^(what|what's|whats|why|how|who|who's|when|where|which|whose|is|are|was|were|does|do|did|can|could|should|would|will|tell me|explain|describe|define|compare|give me|list|name)\b/
const POINTS_AT_BOOK = /\b(this|that|it|these|those)\b/
const MAX_LOOSE_WORDS = 12

/** A duration mentioned anywhere in the phrase: "thirty seconds", "a couple of minutes", "a bit". */
function looseDuration(text: string): number {
  const match = /(\d+(?:\.\d+)?|half a|a couple of|a few|[a-z]+(?: five)?) (seconds?|secs?|minutes?|mins?)\b/.exec(text)
  if (match) {
    const amount = match[1] === 'half a' ? 0.5 : match[1] === 'a couple of' ? 2 : match[1] === 'a few' ? 3 : parseNumber(match[1])
    if (amount !== null) return amount * (match[2].startsWith('m') ? 60 : 1)
  }
  return /\b(a (little|bit|tad|touch|second|moment)|slightly|just a)\b/.test(text) ? 10 : DEFAULT_VOICE_SEEK_SECONDS
}

/** "wake me in half an hour", "timer for about twenty minutes" -> seconds; a quarter of an hour if no time is given. */
function looseTimer(text: string): number {
  if (/\bhalf an hour\b/.test(text)) return 1800
  const match = new RegExp(`(\\d+(?:\\.\\d+)?|an?|[a-z]+(?: five)?) ${TIME_UNIT.source}\\b`).exec(text)
  const amount = match ? parseNumber(match[1]) : null
  if (match && amount !== null) return amount * (match[2].startsWith('h') ? 3600 : match[2].startsWith('m') ? 60 : 1)
  return 900
}

const UNITS: Record<string, 'sentence' | 'paragraph' | 'section' | 'chapter'> = {
  sentence: 'sentence', line: 'sentence', paragraph: 'paragraph', section: 'section', part: 'section', topic: 'section',
  heading: 'section', chapter: 'chapter', unit: 'chapter', lesson: 'chapter',
}
const UNIT = '(sentence|line|paragraph|section|part|topic|heading|chapter|unit|lesson)'

/**
 * Second pass: understand a request from its key words when it did not match a
 * fixed phrase - "could you take me back a little", "I didn't catch that",
 * "make it a bit quicker". Order matters: more specific meanings come first.
 */
const LOOSE: Rule[] = [
  [/\b(never ?mind|cancel|forget (it|that)|no question)\b/, simple('cancel')],
  [/\b(stay|remain|keep (it )?) ?paused\b|\b(don't|do not) (resume|continue|start|go back|carry on)\b/, simple('stayPaused')],
  [/\b(back|return|go|take|jump|bring)\b.*\b(where i was|my place|my spot|where i left off|where i came from)\b/, simple('return')],
  [/\b(sleep|timer)\b/, (m) => (/\b(cancel|off|stop|clear|remove|no)\b/.test(m.input)
    ? { type: 'sleep', off: true } : { type: 'sleep', seconds: looseTimer(m.input) })],
  [/\bskim\w*\b|\bfirst sentences?\b/, (m) => ({ type: 'skim', on: !/\b(stop|off|no|don't|do not|quit|enough)\b/.test(m.input) })],
  [/\bnotes\b/, (m) => (/\b(export|download|save)\b/.test(m.input) ? { type: 'exportNotes' } : { type: 'readNotes' })],
  [/\bnote\b/, () => ({ type: 'note', text: '' })],
  [/\b(table of contents|contents|chapter list)\b/, simple('contents')],
  [/\bwhere (am i|are we|were we|was i)\b|\b(what|which) (page|chapter|section|part)\b|\bhow (much|long|far|many).*\b(left|remaining|to go)\b|\bmy (place|position|progress)\b/, simple('where'), 'orient'],
  [/\b(help|commands?|instructions|what can (i|you) (say|do|ask)|how do(es)? (i|this|it) (use|work))\b/, simple('help'), 'orient'],
  [/\bbookmarks?\b|\b(save|mark|remember) (this|my|the) (place|spot|position|point|page)\b/, (m) => (
    /\b(go|open|jump|take|return|back)\b/.test(m.input) ? { type: 'gotoBookmark' }
      : /\b(list|what|show|read|which|how many)\b/.test(m.input) ? { type: 'listBookmarks' } : { type: 'bookmark' })],
  [/\b(library|bookshelf|my books|(another|different|other) book|close (the |this )?book|exit|leave (the |this )?book)\b/, simple('library')],
  [/\b(quiz|test me|test my|check my understanding|ask me (something|a question))\b/, simple('quiz')],

  // Moving around the book.
  [new RegExp(`\\b(restart|redo|beginning of|start of|from the (start|beginning|top)|start (the |this )?${UNIT} (again|over))\\b.*\\b${UNIT}\\b|\\b${UNIT}\\b.*\\b(from the (start|beginning|top)|again|over)\\b`), (m) => {
    const unit = UNITS[(new RegExp(UNIT).exec(m.input) ?? [])[0] ?? 'section']
    return unit === 'chapter' ? { type: 'restartChapter' } : { type: 'nav', unit, delta: 0 }
  }],
  [new RegExp(`\\b(next|skip|following|upcoming|move on|jump ahead)\\b.*\\b${UNIT}\\b`), (m) => ({ type: 'nav', unit: UNITS[m[2]], delta: 1 })],
  [new RegExp(`\\b(previous|last|prior|earlier|preceding|back (a|one))\\b.*\\b${UNIT}\\b`), (m) => ({ type: 'nav', unit: UNITS[m[m.length - 1]], delta: -1 })],
  [/\bchapter (\d+|[a-z]+)\b/, (m) => {
    const number = parseNumber(m[1])
    return number === null ? null : { type: 'gotoChapter', number }
  }],

  // About the answer or the passage just heard.
  [/\banswer\b.*\b(again|repeat|once more|one more time)\b|\b(repeat|replay|say)\b.*\banswer\b/, simple('replayAnswer')],
  [/\b(simpl(e|er|y|ify)|easier|easy (words|terms|language)|layman|like i'm (five|5|a (child|kid|beginner))|dumb it down|plain (english|words|language)|less (technical|complicated))\b/, qa('simplify'), 'passage'],
  [/\b(example|for instance|illustrat(e|ion)|analogy|real (life|world))\b/, qa('example'), 'passage'],
  [/\b(summar(y|ise|ize|ies)|recap|main (points?|ideas?)|key (points?|ideas?|takeaways?)|gist|overview|in (short|brief)|sum (it|this|that)? ?up)\b/,
    (m, original) => ({ type: 'qa', intent: 'summarize', question: original, scope: /\bchapter\b/.test(m.input) ? 'chapter' : 'section' }), 'passage'],
  [/\b(more (detail|details|about|on|info|information|depth)|elaborate|go deeper|in (more )?depth|expand on|tell me more|say more)\b/, qa('elaborate'), 'passage'],
  [/\b(?:define|definition of|meaning of)\b ?(.*)$/, (m, original) => {
    const term = m[1].replace(/^(the|a|an) /, '').trim()
    return { type: 'qa', intent: 'define', question: original, term: !term || DEICTIC.test(term) ? '' : term }
  }],
  [/\b(explain|clarify|confus(ed|ing)|(don't|didn't|do not|did not|can't|cannot|couldn't) (understand|get|follow)|lost|(makes?|made) no sense|break (it|that|this) down|what does (this|that|it) mean|unclear)\b/, qa('explain'), 'passage'],

  // Voice.
  [/\b(normal|regular|usual|default|original) (speed|pace|rate)\b/, () => ({ type: 'speed', change: 'set', value: 1 })],
  [/\btoo (fast|quick|quickly)\b|\b(slow|slower|slowly)\b/, () => ({ type: 'speed', change: 'down' })],
  [/\btoo slow\b|\b(fast|faster|quick|quicker|quickly|hurry|speed (it |things )?up)\b/, () => ({ type: 'speed', change: 'up' })],
  [/\b(louder|volume up|turn (it|the volume|that) up|(can't|cannot|can barely) hear|too (quiet|soft|low))\b/, () => ({ type: 'volume', change: 'up' })],
  [/\b(quieter|softer|volume down|turn (it|the volume|that) down|too loud|lower the volume)\b/, () => ({ type: 'volume', change: 'down' })],

  // Reading.
  [/\b(continue|resume|carry on|keep (on|going|reading)|go on|go ahead|proceed|unpause|move on|get (going|on with it)|back to (the |my )?(book|reading|story|text|audiobook)|start (it |reading )?again|read on|read (it |this |that |the book |the text )?(aloud|out loud|out|to me)|(start|begin) (the |my )?(book|reading|narration|audiobook)|pick up where|where (i|we) (left off|stopped)|play)\b/, simple('resume')],
  [/\b(back|backwards?|rewind)\b/, (m) => ({ type: 'seek', seconds: -looseDuration(m.input) })],
  [/\b(forwards?|ahead|skip|fast forward)\b/, (m) => ({ type: 'seek', seconds: looseDuration(m.input) })],
  [/\b(repeat|again|once more|one more time|say that|(didn't|did not|couldn't|could not) (hear|catch)|missed (that|it)|come again|pardon|what did (you|it|he|she) (just )?say|what was that)\b/, simple('repeat'), 'orient'],
  [/\b(question|doubt|query|ask (you )?something|something to ask)\b/, simple('ask')],
  [/\b(pause|hold on|hang on|hold up|wait|stop|one (sec|second|moment|minute)|(just|give me|wait) a (sec|second|moment|minute)|be quiet|quiet|silence|shut up|shush|hush|enough|hold it|freeze|take a break|not now)\b/, simple('pause')],
]

/** Intents recognised by key words rather than an exact phrase. They are trusted less (see isCommand). */
const loose = new WeakSet<object>()

function looseMatch(normalized: string, original: string, rules: Rule[]): Intent | null {
  if (normalized.split(' ').length > MAX_LOOSE_WORDS) return null
  for (const [pattern, build] of rules) {
    const match = pattern.exec(normalized)
    const intent = match && build(match, original)
    if (intent) {
      loose.add(intent)
      return intent
    }
  }
  return null
}

const ORIENTATION = LOOSE.filter((rule) => rule[2] === 'orient')
const ABOUT_PASSAGE = LOOSE.filter((rule) => rule[2] === 'passage')

/** Intents that are only a guess from a key word in a phrase no rule recognised as a whole. */
const guessed = new WeakSet<object>()

/**
 * Should the language model be asked what was meant, when one is available? True for a phrase the
 * grammar does not know and for one it only guessed at from a key word. Exact commands, settings
 * and plain questions are acted on directly: they need no interpreting, and "pause" must be instant.
 */
export function needsInterpreting(intent: Intent): boolean {
  return intent.type === 'unknown' || guessed.has(intent)
}

export function parseIntent(text: string): Intent {
  const original = translateIndianCommand(text.trim())
  const normalized = normalize(original)
  if (!normalized) return { type: 'unknown', text: original }
  for (const [pattern, build, tag] of RULES) {
    const match = pattern.exec(normalized)
    const intent = match && build(match, original)
    if (intent) {
      if (tag === 'free') loose.add(intent)
      return intent
    }
  }
  // Any preference can be changed by saying it: "yellow theme", "bigger text", "short answers".
  const setting = parseSetting(normalized)
  if (setting) {
    const intent: Intent = { type: 'setting', ...setting }
    loose.add(intent)
    return intent
  }
  // "Do not ..." opens with a question word but is an instruction.
  if (QUESTION_START.test(normalized) && !/^do not\b/.test(normalized) && normalized.split(' ').length >= 2) {
    // Question-shaped, but really a request to the player ("what page are we on", "what did you say")
    // or about the passage itself ("can you explain that in simpler words").
    return looseMatch(normalized, original, ORIENTATION)
      ?? (POINTS_AT_BOOK.test(normalized) ? looseMatch(normalized, original, ABOUT_PASSAGE) : null)
      ?? { type: 'qa', intent: 'question', question: original }
  }
  const guess = looseMatch(normalized, original, LOOSE)
  if (guess) guessed.add(guess)
  return guess ?? { type: 'unknown', text: original }
}

/**
 * A fixed command phrase, which is acted on even while the narrator is speaking.
 * Free-form questions, key-word matches and commands that carry free text
 * ("find ...", "note that ...") are not: those must first pass the echo filter,
 * so the narrator's own words - "Note that the offset is not changed" - can
 * never trigger them.
 */
export function isCommand(intent: Intent): boolean {
  return intent.type !== 'unknown' && !loose.has(intent) && !(intent.type === 'qa' && intent.intent === 'question')
}
