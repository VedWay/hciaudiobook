/** The command reference, shared by the Help page and the in-player help dialog. */

export const VOICE_COMMANDS: { group: string; items: [say: string, does: string][] }[] = [
  { group: 'Reading', items: [
    ['Start reading', 'Begin, or carry on, reading the book.'],
    ['Pause', 'Pause and keep your place.'],
    ['Continue reading / Resume', 'Carry on from exactly where you stopped.'],
    ['Stop', 'Stop reading. Your place is saved.'],
    ['Repeat that / What did you just say?', 'Hear the last sentence again.'],
    ['Go back 30 seconds / Go forward 30 seconds', 'Jump by any number of seconds or minutes.'],
    ['Next section / Previous section / Next chapter', 'Move through the book. Also: next sentence, next paragraph, go to chapter 2.'],
    ['Faster / Slower / Louder / Quieter', 'Change the speed or volume of the voice.'],
    ['Where am I?', 'Hear the chapter, section, page, and how much is left.'],
    ['Bookmark this / Go to my bookmark', 'Save this place, or return to the last one you saved.'],
  ] },
  { group: 'Finding your way around', items: [
    ['Read the contents / What sections are in this chapter?', 'Hear the chapters of the book, or the sections of this chapter.'],
    ['Go to the section on page faults', 'Jump to a heading by name. Also: go to page 12.'],
    ['Find where it talks about the dirty bit', 'Search the whole book and start reading at the best match.'],
    ['Return to my place', 'After any jump, go back to exactly where you were.'],
    ['Skim / Read this part', 'Hear only the first sentence of each paragraph, then drop back into full reading when something matters.'],
    ['Stop reading in 20 minutes / Stop at the end of this chapter', 'A sleep timer. It always finishes the sentence first.'],
  ] },
  { group: 'Notes for studying', items: [
    ['Take a note', 'The book pauses and listens for your note, then carries on.'],
    ['Note that the TLB is a cache', 'Save a note in one go, pinned to the sentence you were hearing.'],
    ['Read my notes / What did I ask?', 'Hear your notes, or the questions you have asked.'],
    ['Export my notes', 'Download one text file with your notes, bookmarks, questions and answers.'],
  ] },
  { group: 'Asking questions', items: [
    ['Ask a question', 'The book pauses and listens for your question.'],
    ['Just ask it: "What is virtual memory?"', 'You do not need to say "ask a question" first.'],
    ['Explain that / What does this mean?', 'Explains what you were just listening to.'],
    ['Explain this simply', 'The same idea again, in simpler words.'],
    ['Give me an example', 'An example of what you just heard.'],
    ['Define this / Define paging', 'A short definition of a term.'],
    ['Summarize this section', 'The main points of the section you are in.'],
    ['Tell me more', 'More detail on the last answer.'],
    ['Quiz me', 'A question about this section, to check your understanding.'],
    ['Repeat the answer', 'Hear the last answer again.'],
    ['Stay paused', 'Do not go back to the book after the answer.'],
    ['Never mind / Cancel', 'Forget the question and go back to the book.'],
  ] },
  { group: 'Anywhere', items: [
    ['Help / What can I say?', 'Hear the most useful commands.'],
    ['Go to my books / Go to settings / Go to help', 'Move between screens.'],
    ['Yellow theme / Bigger text / Short answers / Sounds only', 'Change any setting by saying it. "What are my settings?" reads them out.'],
    ['Open operating systems', 'On the My books screen: open a book by name or number.'],
    ['Spell paging', 'Hear a word spelled letter by letter.'],
  ] },
]

export const SHORTCUTS: [keys: string[], does: string][] = [
  [['Space', 'K'], 'Play or pause'],
  [['A'], 'Ask a question'],
  [['R'], 'Repeat the last sentence'],
  [['←', '→'], 'Back or forward 10 seconds'],
  [['Shift', '← / →'], 'Back or forward 30 seconds'],
  [['P', 'N'], 'Previous or next section'],
  [['[', ']'], 'Slower or faster'],
  [['-', '='], 'Quieter or louder'],
  [['E'], 'Explain what I just heard'],
  [['X'], 'Give me an example'],
  [['U'], 'Summarize this section'],
  [['Q'], 'Quiz me'],
  [['C'], 'Continue reading (skip the rest of an answer)'],
  [['W'], 'Where am I?'],
  [['B'], 'Bookmark this place'],
  [['I'], 'Skim on or off'],
  [['F'], 'Find in the book'],
  [['O'], 'Read the contents aloud'],
  [['J'], 'Return to my place after a jump'],
  [['D'], 'Dictate a note'],
  [['L'], 'Read my notes'],
  [['Z'], 'Sleep timer: 15, 30, 60 minutes, end of chapter, off'],
  [['M'], 'Microphone on or off (works on every screen)'],
  [['T', '/'], 'Type a command or question (works on every screen)'],
  [['1 to 9'], 'On the My books screen: open that book'],
  [['S'], 'Stop'],
  [['H', '?'], 'Open this help'],
  [['Esc'], 'Cancel a question, or close help'],
]

/** A short spoken version of the reference. */
export const SPOKEN_HELP = 'Here are the main commands. To control reading, say: pause, continue, repeat that, go back 30 seconds, next section, faster, or slower. '
  + 'To ask something, say "ask a question", or just ask it out loud. You can also say: explain that, explain this simply, give me an example, define this, summarize this section, or quiz me. '
  + 'To find your way around, say: read the contents, go to the section on, then a topic, or find, then a topic. After any jump, say "return to my place". Say "skim" to hear only the first sentence of each paragraph. '
  + 'To study, say: take a note, read my notes, or export my notes. '
  + 'Any setting can be changed by saying it, for example: yellow theme, bigger text, or short answers. '
  + 'Say "where am I" to hear your place in the book. '
  + 'On the keyboard: Space plays and pauses, A asks a question, R repeats, the left and right arrows move ten seconds, and H opens help.'

export function HelpContent({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3'
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="help-voice">
        <Heading id="help-voice" className="mb-3 text-2xl">Things you can say</Heading>
        <p className="mb-4 text-muted">
          The wording is flexible. If the microphone is switched off, press <span className="kbd">A</span> first, or type the
          same words into the command box.
        </p>
        {VOICE_COMMANDS.map(({ group, items }) => (
          <div key={group} className="mb-5">
            <p className="mb-2 text-lg font-bold text-accent">{group}</p>
            <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              {items.map(([say, does]) => (
                <div key={say} className="contents">
                  <dt className="font-bold">&ldquo;{say}&rdquo;</dt>
                  <dd className="m-0 mb-2 text-muted sm:mb-0">{does}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <section aria-labelledby="help-keys">
        <Heading id="help-keys" className="mb-3 text-2xl">Keyboard shortcuts</Heading>
        <p className="mb-4 text-muted">
          Shortcuts work on the player screen whenever you are not typing in a text box. Screen reader users: the
          player controls pass keys straight through; elsewhere, switch to focus mode first. If you do not use a
          screen reader, press Tab to move through the buttons: the app says the name of each one.
        </p>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr><th scope="col" className="border-b-2 border-line py-2 pr-4">Key</th><th scope="col" className="border-b-2 border-line py-2">Action</th></tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(([keys, does]) => (
              <tr key={does}>
                <th scope="row" className="whitespace-nowrap border-b border-line py-2 pr-4 font-normal">
                  {keys.map((key, i) => (
                    <span key={key}>{i > 0 && <span className="text-muted"> {keys[0] === 'Shift' ? '+' : 'or'} </span>}<span className="kbd">{key}</span></span>
                  ))}
                </th>
                <td className="border-b border-line py-2">{does}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
