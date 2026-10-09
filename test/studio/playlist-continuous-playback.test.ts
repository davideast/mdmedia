import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { StreamingPcmPlayer, unlockPlaybackAudio } from '../../studio/src/lib/pcm-player';
import { wrapPcmAsWav } from '../../studio/src/lib/wav';

/** Just enough of HTMLAudioElement for the player's native path. */
class FakeAudio extends EventTarget {
  paused = true;
  src = '';
  currentTime = 0;
  duration = 1;
  readyState = 4;
  playbackRate = 1;
  volume = 1;
  preload = '';
  style: Record<string, string> = {};
  isConnected = false;
  plays = 0;
  play() {
    this.plays += 1;
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  end() {
    this.paused = true;
    this.currentTime = this.duration;
    this.dispatchEvent(new Event('ended'));
  }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
  get ended() { return this.paused && this.currentTime >= this.duration; }
}

const created: FakeAudio[] = [];
const saved = { document: globalThis.document, media: (globalThis as Record<string, unknown>).HTMLMediaElement };

beforeAll(() => {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => { const audio = new FakeAudio(); created.push(audio); return audio; },
    body: { appendChild: (element: FakeAudio) => { element.isConnected = true; } },
  };
  (globalThis as Record<string, unknown>).HTMLMediaElement = { HAVE_METADATA: 1 };
});

afterAll(() => {
  (globalThis as Record<string, unknown>).document = saved.document;
  (globalThis as Record<string, unknown>).HTMLMediaElement = saved.media;
});

async function loadedPlayer(): Promise<StreamingPcmPlayer> {
  const player = new StreamingPcmPlayer();
  const wav = wrapPcmAsWav(new Uint8Array(24_000 * 2));
  await player.loadWavUrl(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
  return player;
}

describe('playlist playback across tracks', () => {
  it('plays every track through one audio element so a tap-unlocked element is reused', async () => {
    unlockPlaybackAudio();
    const first = await loadedPlayer();
    await first.play();
    first.destroy();
    const second = await loadedPlayer();
    await second.play();

    expect(created).toHaveLength(1);
    expect(created[0].plays).toBe(3);
    second.destroy();
  });

  it('announces the end of a track from inside the media ended event', async () => {
    const player = await loadedPlayer();
    let ended = 0;
    player.onEnded(() => { ended += 1; });
    await player.play();
    created[0].end();

    expect(ended).toBe(1);
    expect(player.playing).toBe(false);
    player.destroy();
  });

  it('stops a finished track from reacting to the next track on the shared element', async () => {
    const first = await loadedPlayer();
    let firstEnded = 0;
    first.onEnded(() => { firstEnded += 1; });
    first.destroy();
    const second = await loadedPlayer();
    let secondEnded = 0;
    second.onEnded(() => { secondEnded += 1; });
    await second.play();
    created[0].end();

    expect(firstEnded).toBe(0);
    expect(secondEnded).toBe(1);
    second.destroy();
  });

  it('does not replace a loaded track with the unlock silence', async () => {
    const player = await loadedPlayer();
    const src = created[0].src;
    unlockPlaybackAudio();

    expect(created[0].src).toBe(src);
    player.destroy();
  });
});
