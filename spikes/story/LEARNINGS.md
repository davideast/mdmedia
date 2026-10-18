# Story spike: learnings

Run 1, 2026-10-18, `lighthouse.md` (1,185 spoken characters), model
`gemini-3.1-flash-tts-preview`, four calls in flight.

## Measured

| | line | run |
|---|---|---|
| API calls | 16 | 9 |
| Audio | 120.9 s | 107.7 s |
| Wall time | 22.3 s | 16.6 s |
| Output tokens (audio) | 2,815 | 2,556 |
| Input tokens | 537 | 636 |

- **Audio costs 25 output tokens per second**, in both modes. A 10-minute
  story is about 15,000 audio tokens; input is noise next to that.
- **Each call takes 0.4 to 0.9 times its audio length**, so four in flight
  render about five times faster than real time. Speed is not a reason to
  cache yet; money might be, depending on the price per audio token.
- **Every clip carries its own silence: about 250 ms before and 300 ms after**
  (lead 140 to 730 ms, tail 0 to 890 ms). With the 400 ms gap, the real
  space between two lines is about 950 ms, and it varies by call. The gaps
  we write are not the gaps we hear.
- **Run mode is 13 s shorter** for the same text, mostly from seven fewer
  sets of clip edges and gaps. Inside one multi-speaker call the model
  places its own turn pauses (5 to 8 pauses over 300 ms per call).
- **The `0ms` pause tested nothing.** I placed it after Mara's interruption
  instead of between `She says—` and her line, so the interruption itself
  got the full gap plus both clip edges, about 940 ms. Line mode cannot make
  an interruption without trimming clip edges.

## Heard

_To fill in from listening:_

1. Delivery cues (whisper, sharp, barely audible): audible?
2. Mara across seven separate calls: one person?
3. Run mode: more like a scene? Right voice per speaker? Any speaker labels
   or bracketed cues read aloud?
4. Gaps: natural or mechanical?
5. Mara's whisper (`line/calls/014-mara.wav`) ends without a quiet tail; is
   it cut off?

## What this changes in the design (provisional)

- The silence between lines is decided by the model's clip edges as much as
  by our gap, so timing needs either measured trimming or the model's own
  turn-taking (run mode). The design removed silence trimming as unproven;
  it is now proven to matter for timing, if not yet by ear.
- The unit of rendering may not be a line. If run mode sounds better, the
  timeline's clip is a run of up to two speakers, and the cache key covers
  the run.
