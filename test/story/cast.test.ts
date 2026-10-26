import { describe, expect, it } from 'bun:test';
import { castVoices, heardAsWritten, parseStory, spokenText, voiceOf } from '../../src/story/index.js';
import { renderLines } from '../../src/story/render-lines.js';
import { castingSpeaker, fakeJudge, memoryCache, scriptedTranscriber, toneSpeaker } from './fakes.js';

const STORY = `---
title: Mirror
narrator:
  brief: A warm storyteller from Bath, in her sixties.
cast:
  WREN:
    brief: Wren, eleven, from Peckham; a real child's voice with a whistle on her s's.
  NERW:
    voice: WREN
    brief: Wren's exact voice with every edge sanded off.
  ODILE:
    voice: Sulafat
    brief: Eighty-one, from Whitby; a low, dry alto.
pronounce:
  Nerw: Nur-oo
---

*(eerie)* The mirror blinked.

**NERW** *(sweet)*: Hello, Wren. I'm Nerw.

**WREN** *(suspicious)*: That's my name backwards.

**ODILE** *(curt)*: Upstairs.
`;

/** Every voice marked as a woman's: the briefs here are all women and girls. */
const women = Object.fromEntries(['Aoede', 'Gacrux', 'Schedar', 'Leda', 'Kore', 'Sulafat'].map((v) => [v, { gender: 'woman' as const }]));

const parse = async () => (await parseStory(STORY, { path: 'm.md' })).script!;

describe('the story format for casting', () => {
  it('reads briefs, shared voices and respellings', async () => {
    const script = await parse();
    expect(script.cast.WREN!.voice).toBeUndefined();
    expect(script.cast.WREN!.brief).toContain('Peckham');
    expect(script.cast.NERW!.voice).toBe('WREN');
    expect(script.meta.pronounce).toEqual({ Nerw: 'Nur-oo' });
  });

  it('reports a shared voice that names no one in the cast', async () => {
    const { diagnostics } = await parseStory(STORY.replace('voice: WREN', 'voice: GHOST'), { path: 'm.md' });
    expect(diagnostics.map((d) => d.code)).toEqual(['unknown-speaker']);
  });
});

describe('castVoices', () => {
  it('auditions every voice for each uncast character and casts the best fit', async () => {
    const judge = fakeJudge({ Aoede: 9, Gacrux: 2, Schedar: 8 });
    const { script, casting } = await castVoices(await parse(), { speaker: castingSpeaker(), judge, facts: women, cache: memoryCache(), voices: ['Aoede', 'Gacrux', 'Schedar'] });
    // WREN and the narrator have briefs and no voice; NERW shares WREN's; ODILE has one.
    expect(casting.map((c) => c.id).sort()).toEqual(['NARRATOR', 'WREN']);
    expect(script.cast.WREN!.voice).toBe('Aoede');
    expect(voiceOf(script, 'NERW')).toBe('Aoede');
    expect(script.cast.ODILE!.voice).toBe('Sulafat');
    const wren = casting.find((c) => c.id === 'WREN')!;
    expect(wren.ranked.map((a) => a.voice)).toEqual(['Aoede', 'Schedar', 'Gacrux']);
    expect(wren.sample).toBe("That's my name backwards.");
    expect(judge.calls.filter((c) => c.brief.includes('Peckham'))).toHaveLength(3);
  });

  it('gives each character a voice of their own, the most confident cast choosing first', async () => {
    const two = STORY.replace('  ODILE:\n    voice: Sulafat\n', '  ODILE:\n');
    const script = (await parseStory(two, { path: 'm.md' })).script!;
    // Everyone's favourite is Aoede; only one can have it.
    const { casting } = await castVoices(script, { speaker: castingSpeaker(), judge: fakeJudge({ Aoede: 9, Leda: 7, Kore: 6 }), facts: women, cache: memoryCache(), voices: ['Aoede', 'Leda', 'Kore'] });
    const voices = casting.map((c) => c.voice);
    expect(new Set(voices).size).toBe(voices.length);
    expect(voices.sort()).toEqual(['Aoede', 'Kore', 'Leda']);
  });

  it('keeps voices the author wrote for themselves', async () => {
    const { casting } = await castVoices(await parse(), { speaker: castingSpeaker(), judge: fakeJudge({ Sulafat: 9, Aoede: 5 }), facts: women, cache: memoryCache(), voices: ['Sulafat', 'Aoede', 'Leda'] });
    expect(casting.map((c) => c.voice)).not.toContain('Sulafat');
  });

  it('auditions with the brief as the delivery note and casts again only when the brief changes', async () => {
    const cache = memoryCache();
    const speaker = castingSpeaker();
    await castVoices(await parse(), { speaker, judge: fakeJudge(), facts: women, cache, voices: ['Aoede', 'Leda'] });
    expect(speaker.calls.find((c) => c.text.endsWith("That's my name backwards."))!.note).toContain('Peckham');
    const again = castingSpeaker();
    const second = await castVoices(await parse(), { speaker: again, judge: fakeJudge(), facts: women, cache, voices: ['Aoede', 'Leda'] });
    expect(again.calls).toHaveLength(0);
    expect(second.casting.every((c) => c.cached)).toBe(true);
    const changed = (await parseStory(STORY.replace('from Peckham', 'from Croydon'), { path: 'm.md' })).script!;
    const third = castingSpeaker();
    await castVoices(changed, { speaker: third, judge: fakeJudge(), facts: women, cache, voices: ['Aoede', 'Leda'] });
    expect(third.calls.length).toBe(2);
  });
});

describe('casting from voice marks', () => {
  it('only auditions voices marked with the gender the brief names', async () => {
    const speaker = castingSpeaker();
    const facts = { Aoede: { gender: 'woman' as const }, Puck: { gender: 'man' as const } };
    const { casting } = await castVoices(await parse(), { speaker, judge: fakeJudge({ Puck: 10 }), cache: memoryCache(), voices: ['Aoede', 'Puck'], facts });
    expect(casting.find((c) => c.id === 'WREN')!.voice).toBe('Aoede');
    expect(speaker.calls.some((c) => String(c.voice) === 'Puck')).toBe(false);
  });

  it('refuses to cast a gendered brief before any voice is marked', async () => {
    await expect(castVoices(await parse(), { speaker: castingSpeaker(), judge: fakeJudge(), cache: memoryCache(), voices: ['Aoede'], facts: {} })).rejects.toThrow('mark the voices first');
  });
});

describe('voicing with briefs and respellings', () => {
  it("speaks the respelling, sends the brief as the note, and checks against the story's spelling", async () => {
    const { script } = await castVoices(await parse(), { speaker: castingSpeaker(), judge: fakeJudge(), facts: women, cache: memoryCache(), voices: ['Aoede'] });
    const speaker = toneSpeaker();
    // The transcriber writes the respelling it heard; the check maps it back.
    const transcriber = scriptedTranscriber((text) => (text.includes('Nur-oo') ? "Hello, Wren. I'm Nuroo." : undefined));
    const rendered = await renderLines(script, { speaker, transcriber, cache: memoryCache() });
    const hello = speaker.calls.find((c) => c.text.startsWith('Hello'))!;
    expect(hello.text).toBe("Hello, Wren. I'm Nur-oo.");
    expect(hello.voice).toBe('Aoede');
    expect(hello.note).toContain('every edge sanded off');
    expect([...rendered.values()].every((r) => r.result.ok)).toBe(true);
  });

  it('respells whole words only and maps hyphen or space variants back', () => {
    expect(spokenText('Nerw, Nerwish and NERW.', { Nerw: 'Nur-oo' })).toBe('Nur-oo, Nerwish and Nur-oo.');
    expect(heardAsWritten('nur oo and Nur-oo and Nuroo', { Nerw: 'Nur-oo' })).toBe('Nerw and Nerw and Nerw');
  });

  it('refuses to voice a character who was never cast', async () => {
    await expect(renderLines(await parse(), { speaker: toneSpeaker(), transcriber: scriptedTranscriber(), cache: memoryCache() })).rejects.toThrow('has no voice yet');
  });
});
