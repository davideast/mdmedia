import { describe, expect, it } from 'bun:test';
import { compareTranscript } from '../../src/story/index.js';

// Pairs from the prototype (findings run 5): transcription noise must pass,
// real defects must fail.
describe('compareTranscript', () => {
  const cases: Array<[string, string, boolean, string[], string[]]> = [
    ['I tried to laugh. It sounded like a lawn mower failing to start.', 'I tried to laugh. It sounded like a lawnmower failing to start.', true, [], []],
    ["Yeah! Right before we announce the new host. It's going to kill!", "Yeah, right before we announce the new host, it's gonna kill.", true, [], []],
    ["For one second, I thought she'd laugh.", "For 1 second, I thought she'd laugh.", true, [], []],
    ['What. Clip.', 'What?', false, ['clip'], []],
    ['You promised.', 'Ugh. You promised.', false, [], ['ugh']],
    ['I know, but—', 'I know.', false, ['but'], []],
    ["It's probably the worst french fry", 'It’s probably the worst French fry', true, [], []],
  ];
  for (const [expected, heard, ok, missing, extra] of cases) {
    it(`${ok ? 'passes' : 'fails'}: "${expected}" heard as "${heard}"`, () => {
      expect(compareTranscript(expected, heard)).toEqual({ heard, missing, extra, ok });
    });
  }

  it('treats a missing interjection as noise, but keeps it in the result', () => {
    expect(compareTranscript('Heh. Okay. Funny story.', 'Okay. Funny story.')).toMatchObject({ ok: true, missing: ['heh'], extra: [] });
    expect(compareTranscript('Hmm. Six out of ten.', 'Six out of ten.')).toMatchObject({ ok: true, missing: ['hmm'] });
  });

  it('still fails an added interjection, or a missing word beside a missing interjection', () => {
    expect(compareTranscript('You promised.', 'Ugh. You promised.')).toMatchObject({ ok: false, extra: ['ugh'] });
    expect(compareTranscript('Heh. Okay. Funny story.', 'Okay. Story.')).toMatchObject({ ok: false, missing: ['heh', 'funny'] });
  });

  it('reports both a dropped and an added word', () => {
    expect(compareTranscript('My faults are heavy indeed', 'My faults are')).toMatchObject({ missing: ['heavy', 'indeed'], extra: [], ok: false });
    expect(compareTranscript('Hello', '')).toMatchObject({ missing: ['hello'], ok: false });
  });
});
