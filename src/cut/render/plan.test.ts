import { describe, expect, it } from 'bun:test';
import { CUT_FORMAT, keyValueAt, overlayShownAt, resolveCutJson, waveAt, type ResolvedKey, type ResolvedSource, type Timeline } from '../index.js';
import { keysExpr, num, shownExpr, waveExpr } from './expr.js';
import { planRender, renderArgs, soundArgs, soundFilters, type RenderOptions, type RenderPlan } from './plan.js';
import { timeOnTimeline } from './range.js';

/** The render plan, checked without ffmpeg: the graph a cut compiles to. */

type Json = Record<string, unknown>;

function timeline(patch: Json = {}, mediaLength?: (src: ResolvedSource) => number | undefined): Timeline {
  const result = resolveCutJson(
    {
      format: CUT_FORMAT,
      meta: { title: 'T', fps: 24, width: 1280, height: 720 },
      media: { root: '/media' },
      output: 'takes/out.mp4',
      segments: [
        { id: 'a', src: 'take:a', in: 0, out: 2 },
        { id: 'b', src: 'take:b', in: 1, out: 3 },
      ],
      ...patch,
    },
    { mediaLength },
  );
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function plan(patch: Json = {}, options: RenderOptions = {}): RenderPlan {
  const result = planRender(timeline(patch), options);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.plan;
}

/** The one chain in the graph containing every one of `parts`. */
function chain(p: RenderPlan, ...parts: string[]): string {
  const found = p.filters.filter((f) => parts.every((part) => f.includes(part)));
  if (found.length !== 1) throw new Error(`${found.length} chains contain ${parts.join(' & ')}:\n${p.filters.join('\n')}`);
  return found[0];
}

/** Evaluates an ffmpeg expression of `t` (or `T`) in JavaScript. */
function evaluate(expr: string, t: number): number {
  const js = expr.replaceAll('if(', 'IF(').replaceAll('PI', 'Math.PI');
  const fn = new Function(
    't', 'T', 'IF', 'lt', 'between', 'mod', 'sin', 'cos',
    `return ${js};`,
  ) as (...args: unknown[]) => number;
  return fn(
    t, t,
    (c: number, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => (a < b ? 1 : 0),
    (x: number, a: number, b: number) => (x >= a && x <= b ? 1 : 0),
    (a: number, b: number) => a - Math.floor(a / b) * b,
    Math.sin, Math.cos,
  );
}

describe('expressions', () => {
  it('writes numbers ffmpeg reads, with no exponent or trailing zeros', () => {
    expect([num(1), num(0.1 + 0.2), num(-0), num(1e-7), num(-2.5), num(12.3456789)]).toEqual(['1', '0.3', '0', '0', '-2.5', '12.345679']);
  });

  it('turns keyframes into an expression with keyValueAt\'s ramps, holds and jumps', () => {
    const keys: ResolvedKey[] = [
      { t: 1, value: 0.8 }, { t: 1, value: 0.35 }, { t: 1.5, value: 0.35 }, { t: 1.5, value: 0.8 },
      { t: 3, value: 0.8 }, { t: 3.5, value: 0.16 }, { t: 6, value: 0.47 },
    ];
    const expr = keysExpr(keys);
    for (let t = 0; t <= 7; t += 0.05) expect(evaluate(expr, t)).toBeCloseTo(keyValueAt(keys, t), 9);
    expect(evaluate(expr, 1)).toBe(0.35);
    expect(keysExpr([{ t: 0, value: 0.4 }])).toBe('0.4');
  });

  it('turns a wave into an expression in a clock that starts anywhere on the timeline', () => {
    const wave = { shape: 'cos' as const, center: 52, amplitude: -250, period: 1, phase: 0.1, origin: 10 };
    for (const clock of [0, 10, 12.5]) {
      const expr = waveExpr(wave, clock);
      for (let t = 10; t < 12; t += 0.07) expect(evaluate(expr, t - clock)).toBeCloseTo(waveAt(wave, t), 9);
    }
  });

  it('shows an overlay from its start through its end, in its blink', () => {
    const overlay = { start: 8.73, end: 9.93, blink: { period: 0.5, on: 0.3 } };
    const expr = shownExpr(overlay.start, overlay.end, overlay.blink);
    const t = timeline({ overlays: [{ id: 'o', src: 'g.png', at: 0.73, until: 1.93, blink: overlay.blink }] });
    const resolved = t.overlays[0];
    for (let f = 0; f < 60; f++) {
      const time = f / 24;
      expect(evaluate(shownExpr(resolved.start, resolved.end, resolved.blink), time) === 1).toBe(overlayShownAt(resolved, time));
    }
    expect(expr).toBe('between(t,8.73,9.93)*lt(mod(t-8.73,0.5),0.3)');
  });
});

describe('the render plan', () => {
  it('cuts each shot like the CRT TV scripts: trim, fps, scale, hold, and its own sound over the same stretch', () => {
    const p = plan({ segments: [{ id: 'a', src: 'take:a', in: 0.3, out: 1.3, hold: 0.5 }, { id: 'b', src: 'take:b', in: 1, out: 2, audio: { volume: 0.4 } }] });
    expect(p.inputs.map((i) => i.source)).toEqual(['/media/takes/a.mp4', '/media/takes/b.mp4']);
    // Frame k shows the source frame nearest to in + k / 24 (from half a frame before in), so the picture keeps
    // time with the sound.
    expect(chain(p, '[0:v]')).toStartWith('[0:v]trim=start=0.279167:end=1.299999,setpts=PTS-0.3/TB,fps=24:start_time=0,scale=1280:720,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.5');
    // Cut timing: exactly frames 0 to 36 (1.5 s), the source's last frame held if it runs short.
    expect(chain(p, '[seg', 'trim=start_frame=0:end_frame=36')).toContain('tpad=stop_mode=clone');
    // Its sound runs from in to out, then silence through the hold: 1.5 s of samples exactly.
    expect(chain(p, '[0:a]')).toMatch(/^\[0:a\]atrim=start=0\.3:end=1\.3,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_len=72000,atrim=end_sample=72000\[sa\d+\]$/);
    expect(chain(p, '[1:a]')).toContain('volume=0.4,apad=whole_len=48000');
    // Picture and sound are joined separately, so each stays on the cut's times.
    expect(chain(p, 'concat=n=2:v=1:a=0')).toMatch(/^\[seg\d+\]\[seg\d+\]concat/);
    expect(chain(p, 'concat=n=2:v=0:a=1')).toBeTruthy();
    expect(p.output).toMatchObject({ path: '/media/takes/out.mp4', duration: 2.5, width: 1280, height: 720, fps: 24 });
  });

  it('joins picture and sound together in script timing, as the scripts did', () => {
    const p = plan({}, { timing: 'script' });
    expect(chain(p, 'concat=n=2:v=1:a=1')).toMatch(/^\[seg\d+\]\[sa\d+\]\[seg\d+\]\[sa\d+\]concat/);
    expect(chain(p, '[0:a]')).toContain('apad=whole_dur=2');
    expect(p.filters.some((f) => f.includes('end_frame'))).toBe(false);
    expect(chain(p, '[0:v]')).toStartWith('[0:v]trim=start=0:end=1.999999,setpts=PTS-STARTPTS,fps=24,scale=1280:720');
  });

  it('gives a segment of a fraction of a frame its frames on the grid', () => {
    // 1.55 s then 1.55 s at 24 fps: frames 0–37 (38) and 38–74 (37).
    const p = plan({ segments: [{ id: 'a', src: 'take:a', in: 0, out: 1.55 }, { id: 'b', src: 'take:b', in: 0, out: 1.55 }] });
    expect(p.filters.filter((f) => f.includes('end_frame')).map((f) => /end_frame=(\d+)/.exec(f)?.[1])).toEqual(['38', '37']);
  });

  it('holds a still, plays its synth, and pushes in about its focus with its overlays drawn in first', () => {
    const p = plan({
      segments: [
        { id: 'a', src: 'take:a', in: 0, out: 1 },
        { id: 'count', src: 'device.png', still: true, duration: 0.8,
          audio: { synth: { kind: 'tone', frequency: 1950, gain: 0.125 }, out: 0.11, volume: 0.35 },
          zoom: { focus: { x: 872, y: 243 }, keys: [{ at: 0, scale: 1 }, { at: 'count.end', scale: 1.05 }] } },
      ],
      overlays: [{ id: 'digits', src: 'd.png', segment: 'count' }],
    });
    // The still is decoded once and repeated a frame per tick, for its length and a second more.
    expect(p.inputs[1]).toEqual({ options: [], source: '/media/device.png', use: 'segment count' });
    expect(chain(p, '[1:v]')).toStartWith('[1:v]loop=loop=43:size=1:start=0,settb=expr=1/24,setpts=N,trim=start=0:end=0.8,setpts=PTS-STARTPTS,fps=24');
    expect(chain(p, 'sine=')).toStartWith('sine=frequency=1950:duration=0.11:sample_rate=48000,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=0.35');
    // The digits run exactly as long as the shot, drawn in its clock, then the zoom scales both.
    expect(chain(p, '[2:v]')).toContain('format=rgba,loop=loop=43:size=1:start=0,settb=expr=1/24,setpts=N,trim=end=0.8,setpts=PTS-STARTPTS');
    // Drawn on the shot's frames 0 to 19, both ends included.
    expect(chain(p, 'overlay=', "enable='between(t*24,-0.5,19.5)'")).not.toContain('shortest');
    const zoom = chain(p, 'eval=frame,crop');
    expect(zoom).toContain("crop=1280:720:x='872*(iw/1280-1)':y='243*(ih/720-1)'");
    const scale = /scale=w='1280\*\((.*?)\)':h=/.exec(zoom)?.[1] ?? '';
    expect(evaluate(scale, 0)).toBe(1);
    expect(evaluate(scale, 0.4)).toBeCloseTo(1.025, 9);
  });

  it('mixes a layer into its segment\'s sound, under the segment\'s mix fades', () => {
    const p = plan({
      segments: [
        { id: 'a', src: 'take:a', in: 0, out: 2 },
        { id: 'pat', src: 'take:pat', in: 1.07, out: 2.5, audio: { in: 1.15 }, mix: { fadeIn: 0.012, fadeOut: 0.012 } },
      ],
      lines: [{ id: 'pers', speaker: 'Hal', text: 'PERSONALLY!', src: 'take:pers', in: 0.55, out: 1.63, at: 'pat+0.5', fadeOut: 0.15, layer: 'pat' }],
    });
    expect(p.inputs[0]).toMatchObject({ source: '/media/takes/pers.mp4', use: 'line pers' });
    const pers = chain(p, '[0:a]');
    expect(pers).toMatch(/^\[0:a\]atrim=start=0\.55:end=1\.48,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=0\.78:d=0\.15,adelay=delays=24000S:all=1\[s\d+\]$/);
    const mixed = chain(p, 'amix=inputs=2:normalize=0:duration=first');
    expect(mixed).toContain(`]${/(\[s\d+\])$/.exec(pers)?.[1]}amix`);
    expect(chain(p, 'afade=t=in:st=0:d=0.012')).toContain('afade=t=out:st=1.418:d=0.012');
  });

  it('places music and sound effects on the timeline with their volume keys, fades, filters and sync', () => {
    const p = plan({
      segments: [{ id: 'a', src: 'take:a', in: 0, out: 4 }, { id: 'b', src: 'take:b', in: 0, out: 4 }],
      music: [{ id: 'bed', src: 'audio/theme.mp3', in: 1.2, at: 0.5, until: 'b+1', fadeOut: 0.5,
        volume: [{ at: 'b-0.5', value: 1 }, { at: 'b', value: 0.18 }] }],
      sfx: [{ id: 'hey', src: 'audio/hey.wav', at: 'b+0.12', duration: 0.6, volume: 0.8,
        filters: [{ kind: 'highpass', frequency: 500 }, { kind: 'crush', bits: 10, mix: 0.25 }, { kind: 'echo', inGain: 0.8, outGain: 0.6, delay: 0.06, decay: 0.3 }] }],
      mix: { filters: [{ kind: 'limiter', limit: 0.95 }] },
    });
    const bed = chain(p, 'atrim=start=1.2:end=5.7');
    expect(bed).toContain("asetnsamples=n=256:p=0,volume='if(lt(t,3),1,if(lt(t,3.5),1-0.82*(t-3)/0.5,0.18))':eval=frame");
    expect(bed).toContain('afade=t=out:st=4:d=0.5');
    expect(bed).toEndWith('adelay=delays=24000S:all=1[s' + /\[s(\d+)\]$/.exec(bed)?.[1] + ']');
    const hey = chain(p, 'atrim=start=0:end=0.6');
    expect(hey).toContain('highpass=f=500,acrusher=bits=10:mix=0.25,aecho=0.8:0.6:60:0.3,volume=0.8');
    expect(hey).toContain('adelay=delays=197760S:all=1');
    expect(chain(p, 'amix=inputs=3')).toContain('alimiter=limit=0.95');
  });

  it('builds a bed from its parts with linear crossfades, cut to the clip\'s span', () => {
    const p = plan({
      segments: [{ id: 'a', src: 'take:a', in: 0, out: 4 }, { id: 'b', src: 'take:b', in: 0, out: 40 }],
      sfx: [{ id: 'crowd', at: 'a+1', until: 'b+30', fadeIn: 0.5,
        parts: [{ src: 'audio/crowd.mp3', in: 0, out: 20 }, { src: 'audio/crowd.mp3', in: 0, out: 20, crossfade: 2 }] }],
    });
    expect(chain(p, 'acrossfade=d=2')).toMatch(/^\[bed\d+\]\[bed\d+\]acrossfade=d=2\[bed\d+\]$/);
    expect(chain(p, 'atrim=start=0:end=33,asetpts')).toContain('afade=t=in:st=0:d=0.5');
    expect(p.inputs.filter((i) => i.source.endsWith('crowd.mp3'))).toHaveLength(2);
  });

  it('draws overlays over the joined picture: sized, faded, moving, blinking and at their opacity', () => {
    const p = plan({
      overlays: [
        { id: 'title', src: 'title.png', at: 0.25, until: '@end', fadeIn: 0.35, fadeOut: 0.45, width: 640 },
        { id: 'glint', src: 'glint.png', at: 1, duration: 0.7, motion: [{ at: 'glint', x: -430, y: 0 }, { at: 'glint.end', x: 431, y: 0 }] },
        { id: 'glow', src: 'glow.png', at: 2, until: 3, opacity: [{ at: 2.5, value: 1 }, { at: 2.5, value: 0 }, { at: 2.6, value: 0 }, { at: 2.6, value: 1 }] },
        { id: 'half', src: 'half.png', at: 2, until: 3, opacity: 0.5 },
        { id: 'ramp', src: 'ramp.png', at: 2, until: 3, opacity: [{ at: 2, value: 0 }, { at: 3, value: 1 }] },
      ],
    });
    expect(chain(p, '[2:v]')).toBe('[2:v]format=rgba,scale=640:-1,loop=loop=119:size=1:start=0,settb=expr=1/24,setpts=N,fade=t=in:st=0.25:d=0.35:alpha=1,fade=t=out:st=3.55:d=0.45:alpha=1[g' + /\[g(\d+)\]$/.exec(chain(p, '[2:v]'))?.[1] + ']');
    expect(p.inputs[2].options).toEqual([]);
    const glint = chain(p, "x='if(lt(t,1)");
    // From 1 s through 1.7 s: frames 24 to 40, both ends included.
    expect(glint).toContain(":y=0:shortest=1:enable='between(t*24,23.5,40.5)'");
    expect(chain(p, "enable='between(t*24,47.5,72.5)*(")).toContain('if(lt(t,2.5),1,if(lt(t,2.6),0,1))');
    expect(chain(p, 'colorchannelmixer=aa=0.5')).toBeTruthy();
    expect(chain(p, 'geq=')).toContain("a='alpha(X,Y)*(if(lt(T,2),0,if(lt(T,3),0+1*(T-2)/1,1)))'");
  });

  it('finishes the picture with its filters and fades, and halves it for a preview', () => {
    const look = { picture: { fadeOut: 0.5, filters: [
      { kind: 'rescale', width: 600, height: 338 },
      { kind: 'chroma-shift', cb: { x: 4 }, cr: { x: -3 } },
      { kind: 'color', saturation: 0.84, contrast: 0.94, gamma: 1.05 },
      { kind: 'color-balance', shadows: { r: 0.03, b: -0.03 } },
      { kind: 'grain', strength: 12 },
    ] } };
    const p = plan(look);
    expect(chain(p, 'scale=600:338')).toContain(
      'scale=600:338:flags=bilinear,scale=1280:720:flags=bicubic,chromashift=cbh=4:crh=-3,eq=saturation=0.84:contrast=0.94:gamma=1.05,colorbalance=rs=0.03:bs=-0.03,noise=alls=12:allf=t,format=yuv420p,fade=t=out:st=3.5:d=0.5',
    );
    const preview = plan(look, { preview: true });
    expect(chain(preview, 'scale=640:360')).toBeTruthy();
    expect(preview.output).toMatchObject({ width: 640, height: 360, video: { preset: 'veryfast', crf: 26 } });
  });

  it('renders part of the cut: the segments it touches, trimmed, and sound that started earlier cut to fit', () => {
    const p = plan({ music: [{ id: 'm', src: 'm.mp3', at: 0.5, until: '@end' }], overlays: [{ id: 'late', src: 'l.png', at: 3, until: 3.5 }, { id: 'early', src: 'e.png', at: 0, until: 0.5 }] }, { from: 1.5, to: 3.6 });
    expect(p.range).toEqual({ from: 1.5, to: 3.6 });
    expect(p.output.duration).toBe(2.1);
    // Segment a (0–2): frames 36 up to 48; segment b (2–4): frames 48 up to 87.
    expect(chain(p, 'trim=start_frame=36:end_frame=48')).toBeTruthy();
    expect(chain(p, 'trim=start_frame=0:end_frame=39')).toBeTruthy();
    expect(chain(p, 'atrim=start_sample=72000,asetpts')).toBeTruthy();
    expect(chain(p, 'atrim=end_sample=76800,asetpts')).toBeTruthy();
    expect(p.filters.some((f) => f.includes('atrim=start=1,asetpts=PTS-STARTPTS[s'))).toBe(true);
    // Overlays keep their timeline times: the joined picture's clock starts at frame 36.
    expect(chain(p, 'settb=expr=1/24,setpts=N+36')).toBeTruthy();
    expect(p.inputs.map((i) => i.use)).not.toContain('overlay early');
    expect(p.inputs.map((i) => i.use)).toContain('overlay late');
  });

  it('plays a take without a sound track as silence, with a note', () => {
    const result = planRender(timeline(), { hasAudio: (src) => !(src.kind === 'take' && src.name === 'b') });
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.plan.notes).toEqual(["segment b: take:b has no sound track, so the segment's own sound is silent"]);
    expect(chain(result.plan, 'anullsrc')).toContain('atrim=end_sample=96000');
  });

  it('needs a file for each stored asset, and checks its range and output', () => {
    const t = timeline({ overlays: [{ id: 'logo', src: 'asset:pm3f9c', at: 0, until: 1 }] });
    expect(planRender(t)).toEqual({ ok: false, errors: ['overlay logo: asset:pm3f9c is a stored asset with no local file; pass its file to render it'] });
    const withAsset = planRender(t, { assetPath: (id) => `/assets/${id}.png` });
    expect(withAsset.ok && withAsset.plan.inputs.map((i) => i.source)).toContain('/assets/pm3f9c.png');
    expect(planRender(timeline(), { from: 3, to: 2 })).toEqual({ ok: false, errors: ['--to (2) must be after --from (3)'] });
    expect(planRender(timeline(), { to: 9 }).ok).toBe(false);
  });

  it('writes the originals\' output settings', () => {
    const args = renderArgs(plan());
    expect(args.slice(args.indexOf('-map'))).toEqual([
      // -t half a frame past the last of its 96 frames, so the frame that runs past a cut's end is kept.
      '-map', expect.stringMatching(/^\[vout\d+\]$/), '-map', expect.stringMatching(/^\[acat\d+\]$/), '-t', '4.020833',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '24',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '/media/takes/out.mp4',
    ]);
    expect(renderArgs(plan(), { progress: true })).toContain('-progress');
  });
});

describe('times on the command line', () => {
  it('reads seconds, frames and anchors on the resolved timeline', () => {
    const t = timeline();
    expect(['1.5', 'f12', 'b', 'b.end-0.5', 'a+f6', '@end', '@start+1', 'nope', 'b.middle'].map((r) => timeOnTimeline(t, r))).toEqual([1.5, 0.5, 2, 3.5, 0.25, 4, 1, null, null]);
  });
});

describe('the sound alone', () => {
  it("keeps only the chains the sound is made from, so no picture is decoded", () => {
    const p = plan({
      lines: [{ id: 'hi', speaker: 'V', text: 'Hi.', src: 'audio/hi.wav', at: 0.5, duration: 1 }],
      overlays: [{ id: 'logo', src: 'logo.png', at: 0, until: 1 }],
      picture: { fadeOut: 0.5 },
    });
    const kept = soundFilters(p);
    expect(kept.length).toBeLessThan(p.filters.length);
    expect(kept.some((f) => f.includes(':v]') || f.includes('overlay') || f.includes('fade=t=out'))).toBe(false);
    expect(kept.some((f) => f.endsWith(`[${p.audio}]`))).toBe(true);
    expect(kept.filter((f) => f.includes('[0:a]') || f.includes('[1:a]'))).toHaveLength(2);
    const args = soundArgs(p, '/tmp/out.wav');
    expect(args.slice(args.indexOf('-map'))).toEqual(['-map', `[${p.audio}]`, '-t', '4', '-ac', '1', '-c:a', 'pcm_s16le', '-ar', '48000', '/tmp/out.wav']);
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(kept.join(';'));
  });

  it("sends a kept chain's other outputs nowhere, so the graph has none left unconnected", () => {
    expect(soundFilters({ audio: 'out', filters: ['[0:a]asplit=2[x][y]', '[x]volume=2[out]', '[0:v]null[v]'] })).toEqual([
      '[0:a]asplit=2[x][y]', '[x]volume=2[out]', '[y]anullsink',
    ]);
  });
});
