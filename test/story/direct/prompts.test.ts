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
  });

  it('offers every voice with its description, and only those', () => {
    expect(VOICES).toHaveLength(30);
    for (const v of VOICES) expect(CAST_INSTRUCTION).toContain(`${v.name}: ${v.description}`);
    expect(isVoice('Puck')).toBe(true);
    expect(isVoice('Bob')).toBe(false);
  });
});
