# HCI evaluation plan

## Question

Does a voice-interruptible, textbook-grounded audiobook (System B) let blind and visually impaired students resolve
a point of confusion **faster, with less effort, and without losing their place**, compared with a traditional
audiobook (System A)?

## Systems

| | System A: traditional audiobook | System B: RAG audiobook |
|---|---|---|
| Reading | Same narrator, speed and book | Same |
| Navigation | Play/pause, ±10 s and ±30 s, repeat, previous/next section and chapter (comparable to a DAISY player) | Same, plus voice |
| Finding an answer | Navigate and re-listen | Interrupt, ask, hear a grounded answer |
| Returning to your place | Manual | Automatic, to the exact word |

System A is the same player with the assistant and microphone switched off, so the comparison isolates the
interrupt-ask-resume interaction rather than differences in voice or layout. It is deliberately a *strong* baseline:
it has section navigation, which many audiobook apps lack.

The product's other study tools (table of contents by name, find in book, "return to my place", skimming, notes,
sleep timer) are switched off in **both** conditions during a trial. They would give System B several more ways to
reach an answer, which would confound the comparison and bypass the automatic timing of the question flow. They are
candidates for a follow-up study of their own: for example, "find" plus "return to my place" against asking a
question, or skimming against listening at double speed.

## Design

Within-subjects, two conditions, counterbalanced. Each participant does two tasks per system. Two matched task sets
(X and Y) are crossed with system order, giving four sequences assigned in rotation by the dashboard
(AB/XY, BA/XY, AB/YX, BA/YX). Each task starts the participant in a section that uses a term defined **elsewhere**
in the book, which is the realistic moment a listener needs to look something up:

| Task | Start listening at | Find out | Defined in |
|---|---|---|---|
| T1 (X) | Ch. 3, Page Faults | What is the valid bit? | Ch. 2, The Page Table |
| T2 (X) | Ch. 3, Page Replacement Algorithms | What does locality of reference mean? | Ch. 2, The TLB |
| T3 (Y) | Ch. 3, Thrashing and the Working Set | What is the page fault rate? | Ch. 3, Page Faults |
| T4 (Y) | Ch. 2, Pages and Frames | What is external fragmentation? | Ch. 1, Contiguous Allocation |

## Participants

Aim for 8 to 12 students who are blind or have low vision and study from audio or screen-reader material. Blind
users are not one population. Record, and report results alongside: degree and onset of vision loss, main screen
reader, braille use, audiobook/DAISY experience, and voice-assistant experience. Do not exclude people for low
familiarity with voice interfaces; that variation is informative.

## Measures

| Measure | How it is captured |
|---|---|
| Task completion time | Start task → end task (automatic) |
| Number of interactions | Every key, touch, voice command and typed command (automatic) |
| Time to find the answer | From breaking off reading to having the answer. B: interrupt → answer finished (automatic). A: first pause/seek/navigation → researcher presses F8 |
| Time to resume reading | Answer found → narration playing again (automatic) |
| Resume accuracy | Sentences between the interruption point and where reading actually resumed (automatic; 0 means the place was kept) |
| Completion | Whether the task was completed without the researcher's help |
| Comprehension | Spoken answer to the task question, scored against the key: 1, 0.5 or 0 |
| Perceived workload | NASA-TLX (raw), read aloud, after each system |
| Usability | System Usability Scale, read aloud, after each system |
| Satisfaction | One 7-point item after each system |
| Qualitative | Think-aloud notes per trial; closing interview |

## Procedure (about 60 minutes)

1. **Consent**, in the participant's preferred format (read aloud, braille, large print or their own screen reader).
   Make clear that the system is being tested, not them, and that they can stop at any time.
2. **Set-up.** Participant's own headphones if possible. Let them choose speed, voice, verbosity, theme and text
   size, and whether the app or their screen reader speaks status messages. Record the choices.
3. **Practice** on the *Data Structures* book with each system until they say they are ready. Do not time this.
4. **First system:** two tasks. Read the task aloud, press *Start task*, observe without helping, press *End task*
   once they are reading again from their place, ask the task question, score it. Then TLX, SUS, satisfaction.
5. **Break.**
6. **Second system:** the same.
7. **Interview:** What helped? What got in the way? When would you not want to speak aloud (library, lecture,
   shared room)? Did you always know what the system was doing? Did you trust the answers? Which resume point felt
   right: the exact word, or the start of the sentence?

## Analysis

Paired comparisons per participant (mean of their two tasks per system). With this sample size use the Wilcoxon
signed-rank test, report medians and effect sizes (r), and plot every participant's pair rather than only means.
Check for order effects by comparing AB with BA. Treat completion and comprehension descriptively. Analyse the
interview and observation notes thematically, and report failures (misrecognised speech, echo triggers, wrong or
"not in the book" answers) with counts from the event logs. The dashboard exports one row per trial as CSV.

## Ethics and good practice

- Compensate participants for their time; they are contributing expertise.
- Use anonymous codes only. The dashboard stores no names; set `RESEARCHER_PASSCODE`; delete on withdrawal.
- Speech recognised by the browser may be processed by the browser vendor. Say so in the consent information, and
  offer push-to-ask or typed questions as alternatives.
- Do not rush questionnaire items read aloud; offer to repeat the scale every time.
- Pilot with one or two blind users first and fix what they find before collecting data.
- Automated checks and sighted testing do not replace this study. Until it has been run, claims about usability
  for blind students are hypotheses.

## Threats to validity

Learning across tasks on the same book (mitigated by counterbalancing and distinct target terms); the researcher's
F8 timing in System A (one consistent researcher; a second coder on recordings if possible); answer quality depends
on the configured LLM and embeddings (record them in the write-up; do not run the study in offline mode); novelty
may inflate satisfaction for System B; a small, technically confident sample limits generalisation.
