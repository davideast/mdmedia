import { describe, expect, it } from 'bun:test';
import { parseMarkdownToStoryboardScenes } from '../chunker/storyboard-parser.js';
import { CUT_FORMAT, buildStoryboard, resolveCut, type CharacterDelivery, type CutFile, type LineMeasure, type MeasuredCheck, type Timeline } from './index.js';

function words(text: string, start: number, end: number): Array<{ text: string; start: number; end: number }> {
  const ws = text.split(' ');
  const step = (end - start) / ws.length;
  return ws.map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step }));
}

function timeline(patch: Partial<CutFile> = {}): Timeline {
  const cut: CutFile = {
    format: CUT_FORMAT,
    meta: { title: 'Big Hal', fps: 24, width: 1280, height: 720 },
    media: { root: '/m' },
    segments: [
      { id: 'mcu', src: 'take:list', in: 0, out: 3 },
      { id: 'hood', src: 'take:hood', in: 0, out: 4 },
      { id: 'wide', src: 'take:wide', in: 0, out: 4 },
    ],
    lines: [
      { id: 'start', speaker: 'Big Hal', text: 'They start!', segment: 'mcu', at: 'mcu+0.2', until: 'doors', words: words('They start!', 0.2, 0.9) },
      { id: 'doors', speaker: 'Big Hal', text: 'The doors close!', segment: 'mcu', at: 'mcu+1.2', words: words('The doors close!', 1.2, 2.2) },
      { id: 'thisone', speaker: 'Big Hal', text: 'And this one? This one even comes with', segment: 'hood', at: 'hood+0.3', words: words('And this one? This one even comes with', 0.3, 3.5) },
      { id: 'wheels', speaker: 'Big Hal', text: 'wheels!', segment: 'wide', at: 'wide+0.2', until: 'comeon', words: words('wheels!', 0.2, 0.7), delivery: 'the same note as "comes with"' },
      { id: 'comeon', speaker: 'Big Hal', text: "So come on down to Big Hal's!", segment: 'wide', at: 'wide+1', words: words("So come on down to Big Hal's!", 1, 3) },
    ],
    performances: [
      { id: 'list', lines: ['start', 'doors'], intent: 'two items on the list' },
      { id: 'wheels_joke', lines: ['thisone', 'wheels'], intent: 'setup and punchline', delivery: 'an ordinary selling point, one breath, no pause before "wheels"' },
    ],
    ...patch,
  };
  const r = resolveCut(cut);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'));
  return r.value;
}

function measure(id: string, speaker: string, loudness: number, hz: number, range: number, rate: number): LineMeasure {
  return {
    id, speaker, text: '', speech: { start: 0, end: 1 }, timedBy: 'words', words: 3, syllables: 3, loudness,
    pitch: { median: hz, low: hz, high: hz, range, voiced: 1 }, rate: { words: rate, syllables: rate }, wordLevels: [], flags: [],
  };
}

const MEASURED: MeasuredCheck = {
  method: 'dialogue-stem@1', source: '', range: { from: 0, to: 11 }, performances: [],
  lines: [measure('start', 'Big Hal', -23, 240, 3, 2.8), measure('doors', 'Big Hal', -24, 236, 3.4, 2.4), measure('thisone', 'Big Hal', -24, 238, 9, 2.5)],
};

const BASE = `# Big Hal 6: And this one? (list energy)

A 1980s local television commercial shot on video. No music.

The same shot as the first frame, the camera locked off: a medium shot of Big Hal beside the hood.

Where this sits in the commercial: something stale.

Only Hal speaks, an old direction.
`;

describe('the storyboard helper', () => {
  it('gives a shot its whole performance, what was just said and how, its direction, and what comes next', () => {
    const r = buildStoryboard({ timeline: timeline(), target: 'wheels', measured: MEASURED, base: BASE });
    expect(r.lines).toEqual(['thisone', 'wheels']);
    expect(r.performance).toBe('wheels_joke');
    expect(r.previous).toEqual(['start', 'doors']);
    expect(r.next).toBe('comeon');
    expect(r.speech).toBeCloseTo(4.4, 6);
    expect(r.notes).toEqual([
      'wheels is in the performance wheels_joke, so the shot carries all of it (thisone, wheels): never part of a sentence',
      'the title is new; the base storyboard\'s was "Big Hal 6: And this one? (list energy)"',
    ]);
    expect(r.markdown.split('\n\n')).toEqual([
      '# Big Hal: And this one? This one even comes with wheels! (setup and punchline)',
      'A 1980s local television commercial shot on video. No music.',
      'The same shot as the first frame, the camera locked off: a medium shot of Big Hal beside the hood.',
      'Where this sits in the commercial: in the shot just before this one Big Hal has said "They start!" "The doors close!", steady, projected level, mid pitch for this voice, 3 words/s. This shot is the next sentence, in exactly that same voice. Right after this shot, in the next shot, Big Hal goes on: "So come on down to Big Hal\'s!"',
      'Only Big Hal speaks. Big Hal says once, word for word, each word once, with no stumble and no repeated word, all of it as one continuous delivery in one take: "And this one? This one even comes with" "wheels!" An ordinary selling point, one breath, no pause before "wheels". On "wheels!": the same note as "comes with". Then Big Hal stops talking and holds, mouth closed. Big Hal does not say anything else.',
      '[One simple action: what the hands or body do, timed to a word, with explicit negatives (never waves, never points, arms never go wide).]\n',
    ]);
  });

  it('parses as one storyboard scene, so it can be generated from as it is', () => {
    const r = buildStoryboard({ timeline: timeline(), target: 'wheels_joke', measured: MEASURED });
    const scenes = parseMarkdownToStoryboardScenes(r.markdown);
    expect(scenes).toHaveLength(1);
    expect(scenes[0].prompt).toContain('Where this sits in the scene: in the shot just before this one');
  });

  it('opens and closes plainly, with placeholders for the look and the shot when there is no base', () => {
    const first = buildStoryboard({ timeline: timeline(), target: 'list', measured: MEASURED, setting: 'commercial' });
    expect(first.previous).toEqual([]);
    expect(first.markdown).toContain('Where this sits in the commercial: this shot opens the commercial. Right after this shot, in the next shot, Big Hal goes on: "And this one? This one even comes with"');
    expect(first.markdown).toContain('[The look: ');
    expect(first.markdown).toContain('[The shot: ');
    const last = buildStoryboard({ timeline: timeline(), target: 'comeon', measured: MEASURED });
    expect(last.lines).toEqual(['comeon']);
    expect(last.previous).toEqual(['thisone', 'wheels']);
    expect(last.markdown).toContain('Nothing comes after this shot.');
  });

  it("says when it couldn't describe the delivery before, or when the shot is longer than one generation holds", () => {
    const r = buildStoryboard({ timeline: timeline(), target: 'wheels_joke' });
    expect(r.markdown).toContain('in the shot just before this one Big Hal has said "They start!" "The doors close!". This shot');
    expect(r.notes).toContain('no measured check for the lines before it: run mdmedia cut check to describe how they were delivered');
    const long = timeline({
      lines: [{ id: 'all', speaker: 'Big Hal', text: 'A long sentence', segment: 'hood', words: words('A long sentence', 0, 7.5) }],
      segments: [{ id: 'hood', src: 'take:hood', in: 0, out: 8 }],
      performances: [],
    });
    expect(buildStoryboard({ timeline: long, target: 'all' }).notes).toContain(
      "its speech runs 7.5 s; one generation holds a sentence of about 7 s, so if the picture must change, cut it over this one take's sound, never the voice",
    );
  });

  it("writes in a character's register and never-rules, through the character hook", () => {
    const r = buildStoryboard({
      timeline: timeline(), target: 'wheels_joke', measured: MEASURED,
      character: (s) => (s === 'Big Hal' ? { register: 'a proud, sincere, steady local pitchman', never: ['never shouts', 'never winks'] } : undefined),
    });
    expect(r.markdown).toContain('Only Big Hal speaks, a proud, sincere, steady local pitchman.');
    expect(r.markdown).toContain('Big Hal never shouts, never winks.');
  });

  it("writes in the cast's look, its never-rules and usual delivery, for the speaker and anyone else in the shot", () => {
    const profiles: Record<string, CharacterDelivery> = {
      'Big Hal': {
        register: 'a proud pitchman', never: ['never shouts'], ref: 'big-hal@1',
        look: { description: 'a big man in a huge white cowboy hat.', never: ['sunglasses', 'a hat in any other colour'] },
        typical: { loudness: -24.5, pitch: 240, pitchRange: 14, rate: 3.07 },
      },
      Lou: { look: { description: 'a thin salesman in a brown suit', never: [] } },
    };
    const r = buildStoryboard({ timeline: timeline(), target: 'wheels_joke', measured: MEASURED, base: BASE, character: (s) => profiles[s], inShot: ['Lou'] });
    const paragraphs = r.markdown.split('\n\n');
    const where = paragraphs.findIndex((p) => p.startsWith('Where this sits'));
    // After the base's look and framing, before the context.
    expect(paragraphs.slice(where - 2, where)).toEqual([
      'Big Hal looks exactly like this, as in the first frame: a big man in a huge white cowboy hat. Never shown with: sunglasses; a hat in any other colour.',
      'Lou looks exactly like this, as in the first frame: a thin salesman in a brown suit.',
    ]);
    // Loudness and pace only: pitch in words would mislead a video model.
    expect(r.markdown).toContain("Big Hal's usual delivery, as in the approved lines: projected level, 3.07 words/s.");
    expect(r.notes).toContain("Big Hal's look and delivery are from big-hal@1");
    expect(r.markdown).not.toContain('big-hal@1');
  });

  it('refuses an id that is no line or performance', () => {
    expect(() => buildStoryboard({ timeline: timeline(), target: 'nope' })).toThrow('The cut has no line or performance called "nope"');
  });
});
