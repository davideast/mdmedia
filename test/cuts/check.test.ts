import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findFfmpeg } from '../../src/cut/align.js';
import { checkCut, checkFilePath, dialogueStem, loadCutForCheck } from '../../src/cut/check-run.js';
import type { Listener, ListenRequest } from '../../src/cut/listen.js';
import { formatCheckReport } from '../../src/cli/cut-check-command.js';

/**
 * `mdmedia cut check` end to end, with ffmpeg: two takes made here (a quiet
 * setup over a quiet room, and a loud, high payoff over a louder one), cut
 * as one performance, measured from the rendered dialogue and listened to by
 * a stand-in listener.
 */

const execute = promisify(execFile);
let ffmpeg = '';
let dir = '';

async function ff(...args: string[]): Promise<void> {
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
}

function words(text: string, start: number, end: number): Array<{ text: string; start: number; end: number }> {
  const ws = text.split(' ');
  const step = (end - start) / ws.length;
  return ws.map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step - 0.02 }));
}

const CUT = {
  format: 'mdmedia.cut@1',
  meta: { title: 'Check test', fps: 24, width: 160, height: 90 },
  media: { root: '.' },
  output: 'takes/out.mp4',
  segments: [
    { id: 'hood', src: 'take:setup', in: 0, out: 2 },
    { id: 'wide', src: 'take:payoff', in: 0, out: 2.2 },
  ],
  lines: [
    { id: 'setup', speaker: 'Hal', text: 'This one even comes with', segment: 'hood', words: words('This one even comes with', 0.3, 1.6) },
    { id: 'payoff', speaker: 'Hal', text: 'wheels and a great big bow', segment: 'wide', words: words('wheels and a great big bow', 0.4, 1.9) },
  ],
  music: [{ id: 'bed', src: 'audio/bed.wav', at: 0, until: '@end', volume: 0.5 }],
  performances: [{ id: 'joke', lines: ['setup', 'payoff'], intent: 'setup and punchline', delivery: 'an ordinary selling point' }],
};

/** Says every pair is two deliveries and every line is shouted, and counts what it heard. */
class StandIn implements Listener {
  readonly name = 'stand-in';
  heard: ListenRequest[] = [];
  async listen(request: ListenRequest) {
    this.heard.push(request);
    return {
      model: 'stand-in-1',
      canHearAudio: true,
      answers: request.questions.map((q) => ({
        id: q.id,
        verdict: q.id.includes('continuous') ? 'two separate deliveries' : 'yes',
        confidence: 0.9,
        heard: 'a pause, then a shout',
        why: 'the level and pitch jump',
      })),
    };
  }
}

beforeAll(async () => {
  ffmpeg = await findFfmpeg();
  dir = await mkdtemp(path.join(tmpdir(), 'mdmedia-check-test-'));
  await mkdir(path.join(dir, 'takes'));
  await mkdir(path.join(dir, 'audio'));
  const take = async (name: string, expr: string, seconds: number): Promise<void> => {
    await ff('-f', 'lavfi', '-i', `color=c=0x202020:s=160x90:r=24:d=${seconds}`, '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000:d=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', path.join(dir, `takes/${name}.mp4`));
  };
  await take('setup', "'0.05*sin(2*PI*130*t)*between(t,0.3,1.6)+0.002*(random(0)-0.5)'", 2.1);
  await take('payoff', "'0.3*sin(2*PI*300*t)*between(t,0.4,1.9)+0.02*(random(0)-0.5)'", 2.3);
  // Music under it all, which the measurements leave out.
  await ff('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4.2', '-c:a', 'pcm_s16le', path.join(dir, 'audio/bed.wav'));
  await writeFile(path.join(dir, 'test.cut.json'), JSON.stringify(CUT));
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('checking a cut', () => {
  it("measures the dialogue alone: the cut's segments and lines, without its music", async () => {
    const loaded = await loadCutForCheck(path.join(dir, 'test.cut.json'), { ffmpeg });
    const stem = dialogueStem(loaded.timeline);
    expect([stem.music, stem.sfx, stem.overlays]).toEqual([[], [], []]);
    expect(stem.segments).toHaveLength(2);
    expect(stem.lines).toHaveLength(2);
    expect(loaded.hashes.size).toBe(3);
  });

  it('flags the jumps across the boundary, listens, and writes <name>.check.json', async () => {
    const listener = new StandIn();
    const result = await checkCut({ cutPath: path.join(dir, 'test.cut.json'), listen: true, listener, ffmpeg });
    expect(result.checkPath).toBe(path.join(dir, 'test.check.json'));
    expect(checkFilePath(path.join(dir, 'test.cut.json'))).toBe(result.checkPath);
    expect(result.written).toBe(true);

    const p = result.file.measured.performances[0];
    expect(p.flags.map((f) => f.code)).toEqual(['splitting-rule', 'loudness-jump', 'pitch-jump', 'long-pause', 'room-tone-jump']);
    const b = p.boundaries[0];
    expect(b.loudness).toBeGreaterThan(10);
    expect(b.pitch).toBeCloseTo(12 * Math.log2(300 / 130), 0);
    expect(b.pause).toBeCloseTo(0.82, 2);
    expect(p.cuts[0].change).toBeGreaterThan(15);
    const [setup] = result.file.measured.lines;
    expect(setup.pitch?.median).toBeCloseTo(130, -0.5);

    // One clip, with the speech's exact times in it, and the phrases' questions.
    expect(listener.heard).toHaveLength(1);
    const [heard] = listener.heard;
    expect(heard.clip.mimeType).toBe('video/mp4');
    expect(heard.clip.bytes.length).toBeGreaterThan(1000);
    expect(heard.questions.map((q) => q.id)).toEqual(['joke.continuous.setup.payoff', 'joke.shouted.setup', 'joke.shouted.payoff', 'joke.delivery']);
    expect(heard.facts).toContain('Hal: "wheels and a great big bow"');

    const l = result.file.listening.joke;
    expect([l.filterOnly, l.listener, l.model, l.canHearAudio]).toEqual([true, 'stand-in', 'stand-in-1', true]);
    expect(l.answers.map((a) => [a.kind, a.reading, a.agrees])).toEqual([
      ['continuous', 'no', false],
      ['shouted', 'yes', false],
      ['shouted', 'yes', false],
      ['delivery', 'yes', true],
    ]);
    expect(result.listening).toEqual({ joke: { status: 'heard' } });

    const stored = JSON.parse(await readFile(result.checkPath, 'utf8'));
    expect(stored.format).toBe('mdmedia.cut-check@1');
    expect(Object.keys(stored.measured.fingerprints.lines)).toEqual(['setup', 'payoff']);
    expect(Object.keys(stored.listening.joke.fingerprint.sources).sort()).toEqual(['audio/bed.wav', 'take:payoff', 'take:setup']);

    const report = formatCheckReport(result);
    expect(report).toContain('Listening check (filter only: it catches obvious failures, it is not the judge), by stand-in.');
    expect(report).toMatch(/joke\s+setup → payoff\s+0\.82/);
  });

  it('keeps a listening result while what it heard is unchanged, and drops it when that changes', async () => {
    const listener = new StandIn();
    const again = await checkCut({ cutPath: path.join(dir, 'test.cut.json'), listen: true, listener, ffmpeg });
    expect(listener.heard).toHaveLength(0);
    expect(again.listening).toEqual({ joke: { status: 'fresh' } });
    expect(again.written).toBe(false);

    // Moving the payoff's shot changes what is heard there: the stored result is stale.
    const moved = { ...CUT, segments: [CUT.segments[0], { ...CUT.segments[1], in: 0.1 }] };
    await writeFile(path.join(dir, 'test.cut.json'), JSON.stringify(moved));
    const stale = await checkCut({ cutPath: path.join(dir, 'test.cut.json'), ffmpeg });
    expect(stale.listening).toEqual({ joke: { status: 'stale', reason: 'the cut changed there' } });
    expect(stale.file.listening).toEqual({});
    expect(formatCheckReport(stale)).toContain('(dropped: the cut changed there)');
  });
});
