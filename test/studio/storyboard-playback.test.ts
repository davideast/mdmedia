import { describe, expect, it } from 'bun:test';
import { beatReadingText } from '../../studio/src/lib/storyboard-playback';
import { newBeat } from '../../studio/src/lib/storyboard';

describe('storyboard narration text', () => {
  it('keeps walkthrough and verbatim narration distinct', () => {
    const beat = { ...newBeat('one'), summary: 'The story at a glance.', script: 'Spoken words.' };
    expect(beatReadingText(beat, 'board')).toBe('The story at a glance.');
    expect(beatReadingText(beat, 'script')).toBe('Spoken words.');
    expect(beatReadingText({ ...beat, script: '' }, 'script')).toBe('');
    expect(beatReadingText({ ...beat, summary: '' }, 'board')).toBe('Spoken words.');
  });
});
