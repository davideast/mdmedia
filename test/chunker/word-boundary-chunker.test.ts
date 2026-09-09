import { describe, expect, it } from 'bun:test';
import { chunkSpeakableParagraphs } from '../../src/chunker/word-boundary-chunker.js';

describe('chunkSpeakableParagraphs', () => {
  it('keeps chunks strictly within paragraph boundaries without bleeding across paragraphs', () => {
    const p1 =
      'At the core of the system, all playback state flows directly through the playback engine module, located at src/audio/player/playback-engine.ts.';
    const p2 =
      "Let's look at the playback lifecycle. The system moves through four distinct states. It starts in an Idle state.";

    // Chunk with maxChunkChars = 130
    const chunks = chunkSpeakableParagraphs([p1, p2], 130);

    // p1 is 144 chars, so it should split into 2 sub-chunks
    // neither sub-chunk should contain text from p2!
    for (const chunk of chunks) {
      const hasP1 = chunk.text.includes('playback engine module');
      const hasP2 = chunk.text.includes('playback lifecycle');
      expect(hasP1 && hasP2).toBeFalse();
    }

    // The sub-chunk containing "src/audio/player/playback-engine.ts." should not contain "Let's look"
    const pathChunk = chunks.find((c) => c.text.includes('src/audio/player/playback-engine.ts.'));
    expect(pathChunk).toBeDefined();
    expect(pathChunk!.text).not.toContain("Let's look");
  });

  it('preserves single paragraphs shorter than maxChunkChars as individual chunks', () => {
    const paragraphs = [
      'Welcome to the overview.',
      'Here is the second paragraph.',
      'And the final conclusion.',
    ];

    const chunks = chunkSpeakableParagraphs(paragraphs, 400);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toBe('Welcome to the overview.');
    expect(chunks[1].text).toBe('Here is the second paragraph.');
    expect(chunks[2].text).toBe('And the final conclusion.');
  });
});
