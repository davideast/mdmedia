import { describe, expect, it } from 'bun:test';
import { CAST_INSTRUCTION, REPAIR_INSTRUCTION, SCENE_INSTRUCTION } from '../../../src/story/direct/prompts.js';
import { isVoice, VOICES } from '../../../src/story/direct/voices.js';

describe('director instructions', () => {
  it('state every rule the prototype found', () => {
    for (const rule of [
      'word for word',
      'speech tags',
      'Every line and every narration paragraph gets a cue',
      'Never describe an action in a cue',
      'names a silence',
      'Never invent lines',
      'Speech the author already quotes is a normal line',
    ]) expect(SCENE_INSTRUCTION).toContain(rule);
    expect(REPAIR_INSTRUCTION).toContain(SCENE_INSTRUCTION);
    expect(CAST_INSTRUCTION).toContain('"dramatize"');
    expect(CAST_INSTRUCTION).toContain('Never dramatize speech the author already quotes');
    expect(CAST_INSTRUCTION).toContain('giving the reason kills the joke');
  });

  it('asks for a performance brief to cast from, not a voice name', () => {
    for (const part of ['"brief"', 'a real, named place', 'how they laugh', 'what the performance must never become', 'never an adult pitching up']) expect(CAST_INSTRUCTION).toContain(part);
    for (const v of VOICES) expect(CAST_INSTRUCTION).not.toContain(`${v.name}: ${v.description}`);
    expect(isVoice('Puck')).toBe(true);
    expect(isVoice('Bob')).toBe(false);
  });
});
