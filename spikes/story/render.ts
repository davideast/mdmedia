// Throwaway story spike: renders a story markdown file to one MP3 so we can
// listen before designing anything. Not part of the package; see README.md.
//
//   bun spikes/story/render.ts spikes/story/lighthouse.md --mode line
//   bun spikes/story/render.ts spikes/story/lighthouse.md --mode run
//   bun spikes/story/render.ts spikes/story/lighthouse.md --fake   (no API key)

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createGeminiClient } from '../../src/tts/gemini-client-factory.js';
import { DEFAULT_GEMINI_TTS_MODEL } from '../../src/tts/gemini-tts-provider.js';

const RATE = 24000; // headerless 16-bit mono PCM, as every provider here yields

interface Cast { voice: string; delivery: string }
type Segment =
  | { kind: 'line'; speaker: string; delivery: string; text: string }
  | { kind: 'pause'; ms: number }
  | { kind: 'scene'; title: string };

interface Call {
  label: string;
  speakers: string[];
  chars: number;
  ms: number;
  audioMs: number;
  leadMs: number;
  tailMs: number;
  usage?: unknown;
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    mode: { type: 'string', default: 'line' },
    gap: { type: 'string' },
    model: { type: 'string', default: DEFAULT_GEMINI_TTS_MODEL },
    out: { type: 'string' },
    fake: { type: 'boolean', default: false },
  },
});

const file = positionals[0];
if (!file || (values.mode !== 'line' && values.mode !== 'run')) {
  console.error('usage: bun spikes/story/render.ts <story.md> [--mode line|run] [--gap 400ms] [--model id] [--fake]');
  process.exit(2);
}

// ---------- parse (deliberately crude) ----------

const source = await Bun.file(file).text();
const fm = /^---\n([\s\S]*?)\n---\n/.exec(source);
if (!fm) throw new Error('missing front matter');
const meta = Bun.YAML.parse(fm[1]!) as {
  title: string;
  gap?: string;
  narrator: Cast;
  cast?: Record<string, Cast>;
};
const cast: Record<string, Cast> = { NARRATOR: meta.narrator };
for (const [name, member] of Object.entries(meta.cast ?? {})) cast[name.toUpperCase()] = member;

function ms(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*$/.exec(text);
  if (!m) throw new Error(`bad duration: ${text}`);
  return Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
}

const plain = (text: string) =>
  text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/\s+/g, ' ').trim();

const segments: Segment[] = [];
const body = source.slice(fm[0].length);
for (const block of body.split(/\n{2,}/)) {
  const b = block.trim();
  if (!b) continue;
  const pause = /^```pause\n([\s\S]*?)\n```$/.exec(b);
  if (pause) { segments.push({ kind: 'pause', ms: ms(pause[1]!) }); continue; }
  if (/^#\s/.test(b)) continue; // chapter title: displayed only
  if (/^###\s/.test(b) || /^---$/.test(b)) {
    segments.push({ kind: 'scene', title: b.replace(/^#+\s*/, '') });
    continue;
  }
  const line = /^\*\*([^*]+)\*\*\s*(?:\*\(([^)]*)\)\*)?\s*:\s*([\s\S]+)$/.exec(b);
  if (line) {
    const speaker = line[1]!.trim().toUpperCase();
    if (!cast[speaker]) throw new Error(`unknown speaker: ${speaker}`);
    segments.push({ kind: 'line', speaker, delivery: line[2]?.trim() ?? '', text: plain(line[3]!) });
  } else {
    segments.push({ kind: 'line', speaker: 'NARRATOR', delivery: '', text: plain(b) });
  }
}

// ---------- providers ----------

type Speak = (
  lines: Array<{ speaker: string; delivery: string; text: string }>
) => Promise<{ pcm: Uint8Array; usage?: unknown }>;

function styleFor(speaker: string, delivery: string): string {
  return [cast[speaker]!.delivery, delivery].filter(Boolean).join(', ');
}

async function collect(stream: AsyncIterable<any>) {
  const chunks: Uint8Array[] = [];
  let usage: unknown;
  for await (const event of stream) {
    if (event.event_type === 'error') throw new Error(event.error?.message ?? 'Gemini TTS error');
    if (event.event_type === 'step.delta' && event.delta?.type === 'audio' && event.delta.data) {
      chunks.push(new Uint8Array(Buffer.from(event.delta.data, 'base64')));
    }
    const u = event.usage ?? event.interaction?.usage;
    if (u) usage = u;
  }
  return { pcm: concat(chunks), usage };
}

function geminiSpeak(model: string): Speak {
  const client = createGeminiClient();
  return async (lines) => {
    let input: string;
    let speech_config: Array<{ voice: string; speaker?: string }>;
    if (lines.length === 1) {
      const { speaker, delivery, text } = lines[0]!;
      const style = styleFor(speaker, delivery);
      input = style ? `[${style}]\n\n${text}` : text;
      speech_config = [{ voice: cast[speaker]!.voice }];
    } else {
      const speakers = [...new Set(lines.map((l) => l.speaker))];
      const who = speakers.map((s) => `${s} is ${cast[s]!.delivery}.`).join(' ');
      input =
        `Perform this scene as a radio drama. ${who}\n\n` +
        lines.map((l) => `${l.speaker}: ${l.delivery ? `[${l.delivery}] ` : ''}${l.text}`).join('\n');
      speech_config = speakers.map((s) => ({ speaker: s, voice: cast[s]!.voice }));
    }
    const stream = await client.interactions.create({
      model,
      input,
      response_format: { type: 'audio' },
      generation_config: { speech_config },
      stream: true,
    } as any);
    return collect(stream as unknown as AsyncIterable<any>);
  };
}

// A tone per speaker, 55 ms per character, so the mixing can be checked without a key.
const fakeSpeak: Speak = async (lines) => {
  const parts = lines.map(({ speaker, text }) => {
    const hz = 180 + (Object.keys(cast).indexOf(speaker) * 90);
    const n = Math.round((text.length * 55 * RATE) / 1000);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * 6000);
    return concat([silence(120), new Uint8Array(out.buffer), silence(200)]);
  });
  return { pcm: concat(parts) };
};

// ---------- mechanics ----------

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
const silence = (msLen: number) => new Uint8Array(Math.round((msLen * RATE) / 1000) * 2);
const durationMs = (pcm: Uint8Array) => Math.round((pcm.byteLength / 2 / RATE) * 1000);

// Leading and trailing quiet below about -40 dBFS, measured only, never trimmed.
function quietEdges(pcm: Uint8Array): { leadMs: number; tailMs: number } {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  const loud = (v: number) => Math.abs(v) > 330;
  let a = 0; while (a < s.length && !loud(s[a]!)) a++;
  let b = s.length - 1; while (b > a && !loud(s[b]!)) b--;
  return { leadMs: Math.round((a / RATE) * 1000), tailMs: Math.round(((s.length - 1 - b) / RATE) * 1000) };
}

function wav(pcm: Uint8Array): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, t: string) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVE'); w(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, RATE, true); h.setUint32(28, RATE * 2, true); h.setUint16(32, 2, true);
  h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, pcm.byteLength, true);
  return concat([new Uint8Array(h.buffer), pcm]);
}

function ffmpegPath(): string {
  if (process.env.MDMEDIA_FFMPEG) return process.env.MDMEDIA_FFMPEG;
  const bundled = resolve(import.meta.dir, '../../node_modules/ffmpeg-static/ffmpeg');
  return Bun.file(bundled).size ? bundled : 'ffmpeg';
}

// ---------- group into calls ----------

type Lines = Array<{ speaker: string; delivery: string; text: string }>;
type Step = { kind: 'call'; lines: Lines } | { kind: 'pause'; ms: number };

// line: one call per line. run: consecutive lines with at most two speakers and
// no pause or scene break between them share one multi-speaker call.
const steps: Step[] = [];
let sceneBreak = false;
for (const seg of segments) {
  if (seg.kind === 'scene') { sceneBreak = true; continue; }
  if (seg.kind === 'pause') { steps.push({ kind: 'pause', ms: seg.ms }); continue; }
  const last = steps.at(-1);
  const joinable = !sceneBreak;
  sceneBreak = false;
  if (values.mode === 'run' && joinable && last?.kind === 'call') {
    const speakers = new Set([...last.lines.map((l) => l.speaker), seg.speaker]);
    if (speakers.size <= 2) { last.lines.push(seg); continue; }
  }
  steps.push({ kind: 'call', lines: [seg] });
}

// ---------- render ----------

const gapMs = ms(values.gap ?? meta.gap ?? '400ms');
const speak = values.fake ? fakeSpeak : geminiSpeak(values.model!);
const tag = values.fake ? `${values.mode}-fake` : values.mode!;
const out = resolve(values.out ?? join(import.meta.dir, 'out', basename(file, '.md'), tag));
await mkdir(join(out, 'calls'), { recursive: true });

const started = performance.now();
const calls: Call[] = [];
const pcm: Uint8Array[] = new Array(steps.length);

// Calls run four at a time; order in the mix is fixed by index.
const queue = steps.map((step, i) => ({ step, i })).filter((s) => s.step.kind === 'call');
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const lines = (job.step as { lines: Lines }).lines;
      const t0 = performance.now();
      const { pcm: audio, usage } = await speak(lines);
      const label = `${String(job.i).padStart(3, '0')}-${[...new Set(lines.map((l) => l.speaker.toLowerCase()))].join('-')}`;
      pcm[job.i] = audio;
      await writeFile(join(out, 'calls', `${label}.wav`), wav(audio));
      calls.push({
        label,
        speakers: [...new Set(lines.map((l) => l.speaker))],
        chars: lines.reduce((n, l) => n + l.text.length, 0),
        ms: Math.round(performance.now() - t0),
        audioMs: durationMs(audio),
        ...quietEdges(audio),
        usage,
      });
      console.error(`${label}  ${durationMs(audio)} ms audio`);
    }
  })
);

// Gap after every call unless a pause follows; pauses replace it and add up.
const mix: Uint8Array[] = [];
steps.forEach((step, i) => {
  if (step.kind === 'pause') { mix.push(silence(step.ms)); return; }
  mix.push(pcm[i]!);
  const next = steps[i + 1];
  if (next && next.kind === 'call') mix.push(silence(gapMs));
});
const master = concat(mix);
await writeFile(join(out, 'master.wav'), wav(master));

const mp3 = join(out, `${basename(file, '.md')}.mp3`);
const ff = spawnSync(ffmpegPath(), [
  '-y', '-loglevel', 'error', '-i', join(out, 'master.wav'),
  '-af', 'loudnorm=I=-19:TP=-2:LRA=11', '-ar', '48000', '-ac', '2', '-b:a', '160k', mp3,
], { stdio: 'inherit' });
if (ff.status !== 0) throw new Error('ffmpeg failed');

calls.sort((a, b) => a.label.localeCompare(b.label));
const report = {
  file,
  mode: values.mode,
  fake: values.fake,
  model: values.fake ? null : values.model,
  gapMs,
  calls: calls.length,
  chars: calls.reduce((n, c) => n + c.chars, 0),
  wallMs: Math.round(performance.now() - started),
  durationMs: durationMs(master),
  callsDetail: calls,
};
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${mp3}\n${calls.length} calls, ${(report.durationMs / 1000).toFixed(1)} s audio, ${(report.wallMs / 1000).toFixed(1)} s wall`);
