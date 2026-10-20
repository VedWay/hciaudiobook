import { describe, expect, it } from 'vitest'
import { downsample, encodeWav, VAD_SAMPLE_RATE, VoiceSegmenter } from './vad'

const FRAME = 320 // 20 ms at 16 kHz

/** `ms` of sound at a given loudness, as 20 ms frames. A fixed pseudo-random sequence keeps the test repeatable. */
function sound(ms: number, loudness: number, seed = 1): Float32Array[] {
  let state = seed
  const noise = () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 2147483648 - 1
  }
  return Array.from({ length: Math.round(ms / 20) }, () => Float32Array.from({ length: FRAME }, () => noise() * loudness * 1.7))
}

function listen(options = {}) {
  const events: string[] = []
  const utterances: Float32Array[] = []
  const segmenter = new VoiceSegmenter({
    onSpeechStart: () => events.push('start'),
    onSpeechEnd: (samples) => {
      events.push(samples ? 'speech' : 'dismissed')
      if (samples) utterances.push(samples)
    },
  }, options)
  const feed = (...parts: Float32Array[][]) => parts.flat().forEach((frame) => segmenter.push(frame))
  return { segmenter, events, utterances, feed }
}

const QUIET = 0.003
const VOICE = 0.12

describe('VoiceSegmenter', () => {
  it('cuts one utterance out of the quiet around it, with a lead-in so the first sound is not clipped', () => {
    const { events, utterances, feed } = listen()
    feed(sound(1000, QUIET), sound(600, VOICE), sound(1000, QUIET))
    expect(events).toEqual(['start', 'speech'])
    const ms = (utterances[0].length / VAD_SAMPLE_RATE) * 1000
    expect(ms).toBeGreaterThan(600 + 300) // the voice, the lead-in before it...
    expect(ms).toBeLessThan(600 + 350 + 800) // ...and no more than the closing pause after it
  })

  it('reports speech soon after it starts, so the narrator can make way', () => {
    const { events, feed } = listen()
    feed(sound(500, QUIET), sound(140, VOICE))
    expect(events).toEqual([])
    feed(sound(40, VOICE))
    expect(events).toEqual(['start'])
  })

  it('keeps a sentence with a short pause in it together, and separates two sentences', () => {
    const together = listen()
    together.feed(sound(500, QUIET), sound(500, VOICE), sound(400, QUIET), sound(500, VOICE), sound(1000, QUIET))
    expect(together.events).toEqual(['start', 'speech'])

    const apart = listen()
    apart.feed(sound(500, QUIET), sound(500, VOICE), sound(1000, QUIET), sound(500, VOICE), sound(1000, QUIET))
    expect(apart.events).toEqual(['start', 'speech', 'start', 'speech'])
  })

  it('ignores clicks and bumps without ever reporting speech', () => {
    const { events, feed } = listen()
    feed(sound(500, QUIET), sound(60, 0.5), sound(600, QUIET), sound(100, 0.3), sound(1000, QUIET))
    expect(events).toEqual([])
  })

  it('gets used to a noisy room instead of hearing it as endless speech', () => {
    const { segmenter, events, feed } = listen()
    feed(sound(3000, 0.01)) // a fan: steady, and louder than a silent room
    expect(events).toEqual([])
    expect(segmenter.threshold).toBeGreaterThan(0.02)
    feed(sound(600, 0.2), sound(1000, 0.01))
    expect(events).toEqual(['start', 'speech']) // a voice over the fan is still heard
  })

  it('cuts off sound that never stops, and treats it as the new background', () => {
    const { events, feed } = listen({ maxMs: 3000 })
    feed(sound(500, QUIET), sound(4000, 0.08, 2))
    expect(events.slice(0, 2)).toEqual(['start', 'speech'])
    const after = events.length
    feed(sound(3000, 0.08, 3))
    expect(events).toHaveLength(after) // the same level no longer counts as a voice
  })
})

describe('audio helpers', () => {
  it('downsamples 48 kHz to 16 kHz', () => {
    const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / 48000))
    const out = downsample(input, 48000)
    expect(out).toHaveLength(1600)
    expect(Math.max(...out)).toBeGreaterThan(0.9) // a 200 Hz tone survives intact
    expect(downsample(input, 16000)).toBe(input)
  })

  it('writes a valid 16-bit mono WAV file', async () => {
    const blob = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2]))
    expect(blob.type).toBe('audio/wav')
    const view = new DataView(await blob.arrayBuffer())
    const tag = (offset: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)))
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(view.getUint32(4, true)).toBe(36 + 12)
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([1, 1, 16000, 16])
    expect(view.getUint32(40, true)).toBe(12)
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 16383, -16384, 32767, -32768, 32767]) // clipped, not wrapped
  })
})
