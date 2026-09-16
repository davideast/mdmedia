import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioLibrary } from '../../src/storage/audio-library.js';
import { PlaybackEngine } from '../../src/audio/player/playback-engine.js';
import { NarrationRecorder } from '../../src/studio/narration-recorder.js';
import { StudioStore, computeActiveChunkIndex } from '../../src/studio/studio-store.js';
import type { ITTSProvider } from '../../src/tts/tts-provider.interface.js';
import type { VoiceName } from '../../src/types/voice.js';
import type { DocumentChunk } from '../../src/types/chunk.js';
import { createWavHeader } from '../../src/audio/wav-header.js';

class MockTTSProvider implements ITTSProvider {
  constructor(private readonly bytesPerChunk = 4800) {} // 4800 bytes = 100ms

  async *streamAudio(
    text: string,
    voice: VoiceName,
    promptStyle?: string
  ): AsyncIterable<Uint8Array> {
    const half = Math.floor(this.bytesPerChunk / 2);
    yield new Uint8Array(half);
    yield new Uint8Array(half);
  }
}

describe('StudioStore & NarrationRecorder', () => {
  let tempBaseDir: string;
  let brainDir: string;
  let library: AudioLibrary;
  let player: PlaybackEngine;
  let mockProvider: MockTTSProvider;

  beforeEach(() => {
    tempBaseDir = path.join(
      os.tmpdir(),
      `mdmedia_studio_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );
    brainDir = path.join(tempBaseDir, 'brain');
    fs.mkdirSync(brainDir, { recursive: true });

    library = new AudioLibrary(tempBaseDir);
    player = new PlaybackEngine('/usr/bin/true');
    mockProvider = new MockTTSProvider(4800); // 100ms per chunk
  });

  afterEach(() => {
    player.stop();
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  describe('NarrationRecorder', () => {
    it('records PCM deltas, builds WAV buffer, and calculates accurate ChunkTiming intervals', async () => {
      const recorder = new NarrationRecorder(mockProvider);

      const chunks: DocumentChunk[] = [
        { id: 'c1', index: 0, text: 'First paragraph sentence.', charCount: 25, wordCount: 3 },
        { id: 'c2', index: 1, text: 'Second paragraph sentence.', charCount: 26, wordCount: 3 },
      ];

      const result = await recorder.record(chunks, 'Puck');

      expect(result.totalPCMBytes).toBe(9600); // 2 chunks * 4800 bytes
      expect(result.wavBuffer.byteLength).toBe(44 + 9600);
      expect(result.chunkTimings.length).toBe(2);

      // Chunk 0: 0 to 100ms
      expect(result.chunkTimings[0].chunkIndex).toBe(0);
      expect(result.chunkTimings[0].startMs).toBe(0);
      expect(result.chunkTimings[0].endMs).toBe(100);
      expect(result.chunkTimings[0].text).toBe('First paragraph sentence.');

      // Chunk 1: 100ms to 200ms
      expect(result.chunkTimings[1].chunkIndex).toBe(1);
      expect(result.chunkTimings[1].startMs).toBe(100);
      expect(result.chunkTimings[1].endMs).toBe(200);
      expect(result.chunkTimings[1].text).toBe('Second paragraph sentence.');
    });
  });

  describe('computeActiveChunkIndex', () => {
    const timings = [
      { chunkIndex: 0, startMs: 0, endMs: 500, text: 'A' },
      { chunkIndex: 1, startMs: 500, endMs: 1200, text: 'B' },
      { chunkIndex: 2, startMs: 1200, endMs: 2000, text: 'C' },
    ];

    it('returns correct chunk index for timestamp intervals', () => {
      expect(computeActiveChunkIndex(timings, 0)).toBe(0);
      expect(computeActiveChunkIndex(timings, 250)).toBe(0);
      expect(computeActiveChunkIndex(timings, 500)).toBe(0);
      expect(computeActiveChunkIndex(timings, 501)).toBe(1);
      expect(computeActiveChunkIndex(timings, 1200)).toBe(1);
      expect(computeActiveChunkIndex(timings, 1500)).toBe(2);
      expect(computeActiveChunkIndex(timings, 3000)).toBe(2); // Beyond end clamps to last
    });

    it('returns -1 when timings list is empty or undefined', () => {
      expect(computeActiveChunkIndex([], 100)).toBe(-1);
      expect(computeActiveChunkIndex(undefined, 100)).toBe(-1);
    });
  });

  describe('StudioStore', () => {
    it('initializes with library tracks and emits state updates to subscribers', async () => {
      // Pre-populate a track
      const pcmBytes = 48000; // 1000ms
      const header = createWavHeader(pcmBytes);
      const audioBuffer = new Uint8Array(44 + pcmBytes);
      audioBuffer.set(header, 0);

      await library.saveTrack({
        sessionId: 'session-12345678',
        stepIndex: 1,
        markdown: '# Hello Title\nFirst line of content',
        audioBuffer,
        voice: 'Puck',
      });

      const store = new StudioStore({ library, player, ttsProvider: mockProvider, brainDir });

      let receivedState: any = null;
      const unsubscribe = store.subscribe((state) => {
        receivedState = state;
      });

      expect(receivedState).not.toBeNull();
      expect(receivedState.tracks.length).toBe(1);
      expect(receivedState.selectedTrack?.title).toBe('Hello Title');
      expect(receivedState.playback.durationMs).toBe(1000);

      unsubscribe();
    });

    it('selecting a track updates selectedTrack and loads it into PlaybackEngine', async () => {
      const pcm = 48000;
      const h = createWavHeader(pcm);
      const buf = new Uint8Array(44 + pcm);
      buf.set(h, 0);

      const t1 = await library.saveTrack({
        sessionId: 'session-1',
        stepIndex: 1,
        markdown: '# Track 1',
        audioBuffer: buf,
        voice: 'Puck',
      });

      const t2 = await library.saveTrack({
        sessionId: 'session-2',
        stepIndex: 2,
        markdown: '# Track 2',
        audioBuffer: buf,
        voice: 'Fenrir',
      });

      const store = new StudioStore({ library, player, brainDir });
      expect(store.getState().tracks.length).toBe(2);

      await store.selectTrack(t2.id);
      expect(store.getState().selectedTrack?.id).toBe(t2.id);
      expect(store.getState().selectedTrack?.title).toBe('Track 2');
    });

    it('seeking and scrubbing update playback.positionMs and map to correct activeChunkIndex', async () => {
      const pcm = 48000 * 2; // 2000ms
      const h = createWavHeader(pcm);
      const buf = new Uint8Array(44 + pcm);
      buf.set(h, 0);

      const track = await library.saveTrack({
        sessionId: 'session-karaoke',
        stepIndex: 1,
        markdown: 'Sentence 1. Sentence 2.',
        audioBuffer: buf,
        voice: 'Puck',
        chunkTimings: [
          { chunkIndex: 0, startMs: 0, endMs: 1000, text: 'Sentence 1.' },
          { chunkIndex: 1, startMs: 1000, endMs: 2000, text: 'Sentence 2.' },
        ],
      });

      const store = new StudioStore({ library, player, brainDir });
      await store.selectTrack(track.id);

      await store.seek(500);
      expect(store.getState().playback.positionMs).toBe(500);
      expect(store.getState().playback.activeChunkIndex).toBe(0);

      await store.scrub(600); // 500 + 600 = 1100ms
      expect(store.getState().playback.positionMs).toBe(1100);
      expect(store.getState().playback.activeChunkIndex).toBe(1);
    });

    it('filters tracks with setFilter query', async () => {
      const pcm = 4800;
      const h = createWavHeader(pcm);
      const buf = new Uint8Array(44 + pcm);
      buf.set(h, 0);

      await library.saveTrack({
        sessionId: 'session-apples',
        stepIndex: 1,
        markdown: '# Apple Orchard',
        audioBuffer: buf,
        voice: 'Puck',
      });

      await library.saveTrack({
        sessionId: 'session-oranges',
        stepIndex: 2,
        markdown: '# Orange Grove',
        audioBuffer: buf,
        voice: 'Puck',
      });

      const store = new StudioStore({ library, player, brainDir });
      expect(store.getState().tracks.length).toBe(2);

      store.setFilter('apple');
      expect(store.getState().tracks.length).toBe(1);
      expect(store.getState().tracks[0].title).toBe('Apple Orchard');

      store.setFilter('');
      expect(store.getState().tracks.length).toBe(2);
    });

    it('deletes track from library and updates store state', async () => {
      const pcm = 4800;
      const h = createWavHeader(pcm);
      const buf = new Uint8Array(44 + pcm);
      buf.set(h, 0);

      const track = await library.saveTrack({
        sessionId: 'session-del',
        stepIndex: 1,
        markdown: '# To Be Deleted',
        audioBuffer: buf,
        voice: 'Puck',
      });

      const store = new StudioStore({ library, player, brainDir });
      expect(store.getState().tracks.length).toBe(1);

      await store.deleteTrack(track.id);
      expect(store.getState().tracks.length).toBe(0);
      expect(store.getState().selectedTrack).toBeNull();
    });

    it('handles live turn synthesis and serializes concurrent turns', async () => {
      const store = new StudioStore({
        library,
        player,
        ttsProvider: mockProvider,
        brainDir,
        enableLiveAudio: false, // Don't try to spawn system audio player in unit test
      });

      const turn1Promise = store.handleLiveTurn({
        sessionId: 'conv-abc-12345678',
        stepIndex: 1,
        content: '# First Turn Response\nHere is some generated content for turn 1.',
        voice: 'Puck',
      });

      const turn2Promise = store.handleLiveTurn({
        sessionId: 'conv-abc-12345678',
        stepIndex: 2,
        content: '# Second Turn Response\nHere is some generated content for turn 2.',
        voice: 'Fenrir',
      });

      const [track1, track2] = await Promise.all([turn1Promise, turn2Promise]);

      expect(track1).not.toBeNull();
      expect(track2).not.toBeNull();
      expect(track1?.title).toBe('First Turn Response');
      expect(track2?.title).toBe('Second Turn Response');

      const allTracks = store.getState().tracks;
      expect(allTracks.length).toBe(2);
      expect(store.getState().live.isStreaming).toBe(false);
    });
  });
});
