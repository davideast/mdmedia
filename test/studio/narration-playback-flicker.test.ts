import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  observeNarrationDocument,
  projectNarrationView,
  shouldShowPlayerBar,
  type NarrationDocument,
} from '../../studio/src/lib/narration-document';
import { StreamingPcmPlayer, unlockPlaybackAudio } from '../../studio/src/lib/pcm-player';
import { wrapPcmAsWav, type NarrationTimingsFile } from '../../studio/src/lib/wav';
import type { AlignedChunk } from '../../studio/src/lib/types';

const sampleChunks: AlignedChunk[] = [
  {
    index: 0,
    text: 'Spoken article.',
    docOffset: 0,
    startMs: 0,
    endMs: 1200,
    words: [
      { word: 'Spoken', startMs: 0, endMs: 500, charStart: 0, charEnd: 6 },
      { word: 'article.', startMs: 520, endMs: 1200, charStart: 7, charEnd: 15 },
    ],
  },
];

const loadedDocument: NarrationDocument = {
  id: 'nar-1',
  title: 'Architecture Deep Dive',
  voice: 'Kore',
  transcript: 'Spoken article.',
  sourceMarkdown: '# Source\n\nSpoken article.',
  adapted: true,
  chunks: sampleChunks,
  status: 'ready',
  errorMessage: null,
};

describe('Narration Playback Flicker & Disabled Controls Regression', () => {
  describe('Seam 1: Zero-flicker stream projection across isLive transition', () => {
    it('preserves document transcript, title, chunks, and status while playback is loading audio', () => {
      // When the user clicks Play, playback.id becomes 'nar-1' immediately while
      // playback.transcript is still '' and playback.chunks is still [].
      const projected = projectNarrationView('nar-1', loadedDocument, {
        id: 'nar-1',
        title: '',
        voice: null,
        transcript: '',
        sourceMarkdown: null,
        adapted: false,
        chunks: [],
        status: 'loading',
        errorMessage: null,
        player: null,
        playing: false,
        activeWord: null,
        durationMs: 0,
        positionMs: 0,
      });

      expect(projected.transcript).toBe('Spoken article.');
      expect(projected.title).toBe('Architecture Deep Dive');
      expect(projected.voice).toBe('Kore');
      expect(projected.sourceMarkdown).toBe('# Source\n\nSpoken article.');
      expect(projected.adapted).toBe(true);
      expect(projected.chunks).toEqual(sampleChunks);
      expect(projected.status).toBe('ready');
    });

    it('keeps word-aligned loadedDurationMs non-zero in NarrationPage while live player audio is still downloading', () => {
      const pageSource = readFileSync(
        resolve(import.meta.dir, '../../studio/src/app/(app)/narration/[id]/page.tsx'),
        'utf8',
      );
      expect(pageSource).toContain('projectNarrationView(');
      expect(pageSource).toContain('Math.max(stream.durationMs, wordsDurationMs)');
      expect(pageSource).not.toContain(
        'loadedDurationMs={isLive ? stream.durationMs : words.reduce((end, word) => Math.max(end, word.endMs), 0)}',
      );
    });
  });

  describe('Seam 2: Bottom AudioPlayerBar suppression until audio is actually loaded', () => {
    it('does not show AudioPlayerBar when player is null or durationMs is 0 even if transcript is non-empty', () => {
      expect(
        shouldShowPlayerBar({
          hasOfflineTrack: false,
          player: null,
          durationMs: 0,
        }),
      ).toBe(false);

      expect(
        shouldShowPlayerBar({
          hasOfflineTrack: false,
          player: {} as StreamingPcmPlayer,
          durationMs: 0,
        }),
      ).toBe(false);

      expect(
        shouldShowPlayerBar({
          hasOfflineTrack: false,
          player: {} as StreamingPcmPlayer,
          durationMs: 1200,
        }),
      ).toBe(true);

      expect(
        shouldShowPlayerBar({
          hasOfflineTrack: true,
          player: null,
          durationMs: 0,
        }),
      ).toBe(true);
    });

    it('shows the bar the moment audio starts loading, so pressing Play is acknowledged there and not in the page header', () => {
      expect(shouldShowPlayerBar({ hasOfflineTrack: false, player: null, durationMs: 0, loadingAudio: true })).toBe(true);
      expect(shouldShowPlayerBar({ hasOfflineTrack: false, player: null, durationMs: 0, loadingAudio: false })).toBe(false);
    });

    it('the player bar draws a loading line in place of the scrubber until sound starts', () => {
      const bar = readFileSync(resolve(import.meta.dir, '../../studio/src/components/reader/audio-player-bar.tsx'), 'utf8');
      const shell = readFileSync(resolve(import.meta.dir, '../../studio/src/components/shell/app-shell.tsx'), 'utf8');
      expect(bar).toContain('role="progressbar"');
      expect(bar).toContain('Loading audio');
      expect(shell).toContain('loadingAudio');
    });

    it('AppShell uses shouldShowPlayerBar and never pops up a disabled player bar from transcript presence alone', () => {
      const appShellSource = readFileSync(
        resolve(import.meta.dir, '../../studio/src/components/shell/app-shell.tsx'),
        'utf8',
      );
      expect(appShellSource).toContain('shouldShowPlayerBar(');
      expect(appShellSource).not.toContain('(isNarrationRoute && stream.transcript.length > 0)');
    });
  });

  describe('Seam 3: Web Audio AudioContext unlock for streaming checkpoints', () => {
    const savedWindow = (globalThis as Record<string, unknown>).window;
    const savedDocument = globalThis.document;
    let userGestureActive = false;

    class GestureGatedAudioContext {
      state: 'suspended' | 'running' | 'closed' = 'suspended';
      currentTime = 0;
      destination = {};
      resume() {
        if (userGestureActive) {
          this.state = 'running';
        }
        return Promise.resolve();
      }
      close() {
        this.state = 'closed';
        return Promise.resolve();
      }
      createGain() {
        return {
          gain: { value: 1, setValueAtTime: () => {} },
          connect: () => {},
        };
      }
      createBuffer(_channels: number, length: number, sampleRate: number) {
        return {
          duration: length / sampleRate,
          copyToChannel: () => {},
        };
      }
      createBufferSource() {
        return {
          buffer: null,
          playbackRate: { value: 1 },
          connect: () => {},
          disconnect: () => {},
          start: () => {},
          stop: () => {},
          onended: null as (() => void) | null,
        };
      }
    }

    beforeEach(() => {
      userGestureActive = false;
      (globalThis as Record<string, unknown>).window = {
        AudioContext: GestureGatedAudioContext,
      };
      (globalThis as Record<string, unknown>).document = {
        createElement: () => ({
          paused: true,
          preload: '',
          style: {},
          isConnected: false,
          play: () => Promise.resolve(),
          pause: () => {},
          removeAttribute: () => {},
          load: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
        body: { appendChild: () => {} },
      };
    });

    afterEach(() => {
      (globalThis as Record<string, unknown>).window = savedWindow;
      (globalThis as Record<string, unknown>).document = savedDocument;
    });

    it('unlocks Web Audio during user gesture so async streaming checkpoint playback succeeds', async () => {
      // 1. User clicks Play (inside user gesture)
      userGestureActive = true;
      unlockPlaybackAudio();
      userGestureActive = false;

      // 2. Moments later (outside user gesture), streaming checkpoint finishes downloading
      const player = new StreamingPcmPlayer();
      const wav = wrapPcmAsWav(new Uint8Array(24_000 * 2));
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      try {
        await player.loadWavUrl(url, { final: false });
      } finally {
        URL.revokeObjectURL(url);
      }

      await player.play();
      expect(player.playing).toBe(true);
      player.destroy();
    });
  });

  describe('Seam 4: useNarrationStream.loadExisting concurrency, streaming reuse, and listener cleanup', () => {
    const streamSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/lib/use-narration-stream.ts'),
      'utf8',
    );

    it('reuses an active streaming player with loaded audio instead of resetting on Play or word seek', () => {
      expect(streamSource).toContain(
        "(statusRef.current === 'ready' || statusRef.current === 'streaming')",
      );
    });

    it('coalesces repeated loadExisting calls for the same narration while loading or waiting for first checkpoint', () => {
      expect(streamSource).toContain('activeLoadIdRef.current === narrationId');
      expect(streamSource).toContain('pendingOptionsRef.current');
    });

    it('unsubscribes watchNarration immediately when a cached ready snapshot is delivered synchronously', () => {
      expect(streamSource).toContain('shouldStopWatch');
      expect(streamSource).toContain('if (shouldStopWatch || session !== loadSessionRef.current)');
    });

    it('does not detach watchNarration after 15 seconds while a multi-chunk narration is still streaming', () => {
      expect(streamSource).not.toContain('Date.now() - narration.updatedAt > 15_000');
    });
  });
});
