// Throwaway story spike: renders a story markdown file to one MP3 so we can
// listen before designing anything. Not part of the package; see README.md.
//
//   bun spikes/story/render.ts spikes/story/lighthouse.md --mode line
//   bun spikes/story/render.ts spikes/story/lighthouse.md --mode run
//   bun spikes/story/render.ts spikes/story/lighthouse.md --fake   (no API key)

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createGeminiClient } from '../../src/tts/gemini-client-factory.js';
import { DEFAULT_GEMINI_TTS_MODEL } from '../../src/tts/gemini-tts-provider.js';

const RATE = 24000; // headerless 16-bit mono PCM, as every provider here yields

interface Cast { voice: string; delivery: string }
interface Line {
  speaker: string;
  delivery: string;
  text: string;
  display: string;
  narration: boolean;
  scene: number;
  id: number;
}
type Segment =
  | ({ kind: 'line' } & Line)
  | { kind: 'pause'; ms: number }
  | { kind: 'scene'; title: string }
  | { kind: 'music'; prompt: string };

interface Call {
  label: string;
  speakers: string[];
  chars: number;
  ms: number;
  audioMs: number;
  leadMs: number;
  tailMs: number;
  usage?: unknown;
  cached?: boolean;
  fallback?: string;
}

interface Failure { label: string; code?: unknown; message: string; input?: string }

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    mode: { type: 'string', default: 'line' },
    gap: { type: 'string' },
    model: { type: 'string', default: DEFAULT_GEMINI_TTS_MODEL },
    out: { type: 'string' },
    fake: { type: 'boolean', default: false },
    'max-run': { type: 'string', default: '1500' },
    // Verbatim models only: also tell each line what was just said.
    context: { type: 'boolean', default: false },
    // Run mode: cut a run into lines at its real pauses, not by character share.
    snap: { type: 'boolean', default: false },
  },
});

const file = positionals[0];
if (!file || (values.mode !== 'line' && values.mode !== 'run')) {
  console.error('usage: bun spikes/story/render.ts <story.md> [--mode line|run] [--gap 400ms] [--model id] [--max-run 1500] [--fake]');
  process.exit(2);
}

// ---------- parse (deliberately crude) ----------

const source = await Bun.file(file).text();
const fm = /^---\n([\s\S]*?)\n---\n/.exec(source);
if (!fm) throw new Error('missing front matter');
const meta = Bun.YAML.parse(fm[1]!) as {
  title: string;
  gap?: string;
  narrator: Cast | string;
  cast?: Record<string, Cast>;
};
const cast: Record<string, Cast> = {};
for (const [name, member] of Object.entries(meta.cast ?? {})) cast[name.toUpperCase()] = member;
// `narrator: MILO` makes a cast member the narrator: narration is his voice, marked as narration.
const narrator = typeof meta.narrator === 'string' ? meta.narrator.toUpperCase() : 'NARRATOR';
if (typeof meta.narrator !== 'string') cast.NARRATOR = meta.narrator;
if (!cast[narrator]) throw new Error(`narrator ${narrator} is not in the cast`);

function ms(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*$/.exec(text);
  if (!m) throw new Error(`bad duration: ${text}`);
  return Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
}

const plain = (text: string) =>
  text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/\s+/g, ' ').trim();

const segments: Segment[] = [];
const body = source.slice(fm[0].length);
let scene = 0;
let id = 0;
for (const block of body.split(/\n{2,}/)) {
  const b = block.trim();
  if (!b) continue;
  const fence = /^```(\w+)\n([\s\S]*?)\n```$/.exec(b);
  if (fence) {
    if (fence[1] === 'pause') segments.push({ kind: 'pause', ms: ms(fence[2]!) });
    if (fence[1] === 'music') segments.push({ kind: 'music', prompt: fence[2]!.trim() });
    continue; // other blocks (sfx, art) are notes for later steps
  }
  if (/^#\s/.test(b)) continue; // chapter title: displayed only
  if (/^###\s/.test(b) || /^---$/.test(b)) {
    scene++;
    segments.push({ kind: 'scene', title: b.replace(/^#+\s*/, '') });
    continue;
  }
  const line = /^\*\*([^*]+)\*\*\s*(?:\*\(([^)]*)\)\*)?\s*:\s*([\s\S]+)$/.exec(b);
  if (line) {
    const speaker = line[1]!.trim().toUpperCase();
    if (!cast[speaker]) throw new Error(`unknown speaker: ${speaker}`);
    const text = plain(line[3]!);
    segments.push({ kind: 'line', speaker, delivery: line[2]?.trim() ?? '', text, display: text, narration: false, scene, id: id++ });
  } else {
    const text = plain(b);
    segments.push({ kind: 'line', speaker: narrator, delivery: '', text, display: text, narration: true, scene, id: id++ });
  }
}

// ---------- providers ----------

type Lines = Line[];

type Speak = (
  lines: Lines
) => Promise<{ pcm: Uint8Array; usage?: unknown; cached?: boolean; fallback?: string }>;


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

// Renders are cached by request, so a rerun only pays for calls that changed or failed.
const CACHE = join(import.meta.dir, 'out', '.cache');

// GEMINI_API_KEY from the environment, else the file a person put there for this spike.
const KEY_FILE = join(homedir(), '.config', 'mdmedia', 'gemini-key');

async function geminiKey(): Promise<string> {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const file = Bun.file(KEY_FILE);
  if (await file.exists()) return (await file.text()).trim();
  throw new Error(`Set GEMINI_API_KEY or write the key to ${KEY_FILE}.`);
}

// Cue levels tried in order when the input filter refuses a prompt:
// 0 = character default plus line cue, 1 = line cue only, 2 = no cue.
const CUE_LEVELS = ['full cue', 'line cue only', 'no cue'] as const;

// Verbatim TTS models take the words and the delivery note as separate
// fields, so a note can never be spoken. One line per call.
const VERBATIM = new Set(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
const allLines = segments.filter((s): s is { kind: 'line' } & Line => s.kind === 'line');
function contextFor(line: Line): string {
  const i = allLines.findIndex((l) => l.id === line.id);
  const before = allLines.slice(Math.max(0, i - 2), i);
  if (!before.length) return '';
  return 'Just before this, in the same scene: ' + before.map((l) => `${l.speaker} said "${l.text}"`).join(' Then ') + '.';
}

function buildRequest(model: string, lines: Lines, level: number) {
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  if (VERBATIM.has(model)) {
    if (lines.length !== 1) throw new Error('verbatim models render one line per call; use --mode line');
    const l = lines[0]!;
    const style = [
      level === 0 ? cast[l.speaker]!.delivery : '',
      level < 2 ? l.delivery : '',
      values.context && level === 0 ? contextFor(l) : '',
    ].filter(Boolean).join('. ');
    const input = [{ type: 'user_input', content: [{ type: 'text', text: l.text, ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}) }] }];
    return { model, input, speech_config: [{ voice: cast[l.speaker]!.voice }] };
  }
  let input: string;
  let speech_config: Array<{ voice: string; speaker?: string }>;
  const lineCue = (l: Line) => (level < 2 ? l.delivery : '');
  if (speakers.length === 1) {
    // One voice: the character's default once, then a short cue per paragraph where written.
    const head = level === 0 ? `[${cast[speakers[0]!]!.delivery}]\n\n` : '';
    input =
      head +
      lines
        .map((l) => (lineCue(l) ? `[${lineCue(l)}] ${l.text}` : l.text))
        .join('\n\n');
    speech_config = [{ voice: cast[speakers[0]!]!.voice }];
  } else {
    const who = level === 0 ? ' ' + speakers.map((s) => `${s} is ${cast[s]!.delivery}.`).join(' ') : '';
    input =
      `Perform this scene as a radio drama.${who} Words in square brackets are ` +
      `performance notes: follow them, never say them aloud. Never say the speaker names.\n\n` +
      lines.map((l) => `${l.speaker}: ${lineCue(l) ? `[${lineCue(l)}] ` : ''}${l.text}`).join('\n');
    speech_config = speakers.map((s) => ({ speaker: s, voice: cast[s]!.voice }));
  }
  return { model, input, speech_config };
}

function geminiSpeak(model: string, apiKey: string): Speak {
  const client = createGeminiClient({ getApiKey: () => apiKey });
  return async (lines) => {
    for (let level = 0; ; level++) {
      const request = buildRequest(model, lines, level);
      const key = new Bun.CryptoHasher('sha256').update(JSON.stringify(request)).digest('hex');
      const cached = Bun.file(join(CACHE, `${key}.pcm`));
      const fallback = level > 0 ? CUE_LEVELS[level] : undefined;
      if (await cached.exists()) {
        return { pcm: new Uint8Array(await cached.arrayBuffer()), cached: true, fallback };
      }
      try {
        const stream = await client.interactions.create({
          model,
          input: request.input,
          response_format: VERBATIM.has(model) ? { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 } : { type: 'audio' },
          generation_config: { speech_config: request.speech_config },
          stream: true,
        } as any);
        const result = await collect(stream as unknown as AsyncIterable<any>);
        await mkdir(CACHE, { recursive: true });
        await writeFile(join(CACHE, `${key}.pcm`), result.pcm);
        return { ...result, fallback };
      } catch (error: any) {
        const code = error?.error?.error?.code ?? error?.error?.code ?? error?.status;
        if (code === 'prohibited_content' && level < CUE_LEVELS.length - 1) continue;
        throw Object.assign(new Error(error?.error?.message ?? error?.message ?? String(error)), {
          code,
          input: request.input,
        });
      }
    }
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

// Quiet stretches of at least 120 ms (20 ms windows under about -38 dBFS).
function pauses(pcm: Uint8Array): Array<{ mid: number; len: number }> {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  const win = RATE / 50;
  const out: Array<{ mid: number; len: number }> = [];
  let start = -1;
  for (let w = 0; w * win < s.length; w++) {
    let sum = 0;
    for (let i = w * win; i < Math.min(s.length, (w + 1) * win); i++) sum += s[i]! * s[i]!;
    const quiet = Math.sqrt(sum / win) < 420;
    if (quiet && start < 0) start = w;
    if ((!quiet || (w + 1) * win >= s.length) && start >= 0) {
      const len = (w - start) * 20;
      if (len >= 120) out.push({ mid: (start * 20 + w * 20) / 2, len });
      start = -1;
    }
  }
  return out;
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

type Step = { kind: 'call'; lines: Lines } | { kind: 'pause'; ms: number };

// line: one call per line. run: consecutive lines with at most two speakers and
// no pause or scene break between them share one multi-speaker call, up to
// --max-run characters (about two minutes of audio at the default).
const steps: Step[] = [];
// Scene titles and music cues are markers on the next line; the mix gives them times.
const markers: Array<{ kind: 'scene' | 'music'; text: string; lineId: number }> = [];
let pendingMarkers: Array<{ kind: 'scene' | 'music'; text: string }> = [];
let sceneBreak = false;
for (const seg of segments) {
  if (seg.kind === 'scene') { sceneBreak = true; pendingMarkers.push({ kind: 'scene', text: seg.title }); continue; }
  if (seg.kind === 'music') { pendingMarkers.push({ kind: 'music', text: seg.prompt }); continue; }
  if (seg.kind === 'pause') { steps.push({ kind: 'pause', ms: seg.ms }); continue; }
  for (const m of pendingMarkers) markers.push({ ...m, lineId: seg.id });
  pendingMarkers = [];
  const last = steps.at(-1);
  const joinable = !sceneBreak;
  sceneBreak = false;
  if (values.mode === 'run' && joinable && last?.kind === 'call') {
    const speakers = new Set([...last.lines.map((l) => l.speaker), seg.speaker]);
    const chars = last.lines.reduce((n, l) => n + l.text.length, 0) + seg.text.length;
    if (speakers.size <= 2 && chars <= Number(values['max-run'])) { last.lines.push(seg); continue; }
  }
  steps.push({ kind: 'call', lines: [seg] });
}

// ---------- render ----------

const gapMs = ms(values.gap ?? meta.gap ?? '400ms');
const speak = values.fake ? fakeSpeak : geminiSpeak(values.model!, await geminiKey());
const tag = values.fake ? `${values.mode}-fake` : values.mode!;
const out = resolve(values.out ?? join(import.meta.dir, 'out', basename(file, '.md'), tag));
await mkdir(join(out, 'calls'), { recursive: true });

const started = performance.now();
const calls: Call[] = [];
const failures: Failure[] = [];
const pcm: Uint8Array[] = new Array(steps.length);

// Calls run four at a time; order in the mix is fixed by index.
const queue = steps.map((step, i) => ({ step, i })).filter((s) => s.step.kind === 'call');
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const lines = (job.step as { lines: Lines }).lines;
      const t0 = performance.now();
      const label = `${String(job.i).padStart(3, '0')}-${[...new Set(lines.map((l) => l.speaker.toLowerCase()))].join('-')}`;
      let result;
      try {
        result = await speak(lines);
      } catch (error: any) {
        // A refused call becomes one second of silence so the rest of the story still mixes.
        failures.push({ label, code: error.code, message: error.message, input: error.input });
        pcm[job.i] = silence(1000);
        console.error(`${label}  FAILED  ${error.code ?? ''} ${error.message.split('\n')[0]}`);
        continue;
      }
      const { pcm: audio, usage, cached, fallback } = result;
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
        cached,
        fallback,
      });
      console.error(`${label}  ${durationMs(audio)} ms audio`);
    }
  })
);

// Gap after every call unless a pause follows; pauses replace it and add up.
// Each line gets a start and end: exact for one-line calls, and for a run the
// speech between the clip's quiet edges is shared out by character count.
const mix: Uint8Array[] = [];
const timeline: Array<Omit<Line, 'delivery'> & { delivery: string; startMs: number; endMs: number }> = [];
let cursor = 0;
steps.forEach((step, i) => {
  if (step.kind === 'pause') { mix.push(silence(step.ms)); cursor += step.ms; return; }
  const audio = pcm[i]!;
  const length = durationMs(audio);
  const { leadMs, tailMs } = quietEdges(audio);
  const speech = Math.max(1, length - leadMs - tailMs);
  const total = step.lines.reduce((n, l) => n + l.text.length, 0) || 1;
  // Boundaries by character share, then (with --snap) moved to the middle of
  // the nearest real pause in the audio.
  const bounds: number[] = [];
  let acc = leadMs;
  for (const l of step.lines.slice(0, -1)) { acc += (speech * l.text.length) / total; bounds.push(acc); }
  if (values.snap && bounds.length) {
    const quiet = pauses(audio);
    let floor = leadMs;
    bounds.forEach((b, k) => {
      const reach = Math.max(400, ((speech * step.lines[k]!.text.length) / total) * 0.45);
      const near = quiet.filter((q) => q.mid > floor + 150 && Math.abs(q.mid - b) <= reach)
        .sort((a, c) => Math.abs(a.mid - b) / a.len - Math.abs(c.mid - b) / c.len)[0];
      if (near) bounds[k] = near.mid;
      floor = bounds[k]!;
    });
  }
  const edges = [leadMs, ...bounds, length - tailMs];
  step.lines.forEach((l, k) => {
    timeline.push({ ...l, startMs: Math.round(cursor + edges[k]!), endMs: Math.round(cursor + edges[k + 1]!) });
  });
  mix.push(audio);
  cursor += length;
  const next = steps[i + 1];
  if (next && next.kind === 'call') { mix.push(silence(gapMs)); cursor += gapMs; }
});
const startOf = new Map(timeline.map((l) => [l.id, l.startMs]));
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
  failures,
  callsDetail: calls,
};
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(
  join(out, 'timeline.json'),
  JSON.stringify(
    {
      title: meta.title,
      durationMs: report.durationMs,
      cast: Object.fromEntries(Object.entries(cast).map(([k, v]) => [k, v.voice])),
      narrator,
      scenes: markers.filter((m) => m.kind === 'scene').map((m) => ({ title: m.text, startMs: startOf.get(m.lineId) ?? 0 })),
      music: markers.filter((m) => m.kind === 'music').map((m) => ({ prompt: m.text, atMs: startOf.get(m.lineId) ?? 0 })),
      lines: timeline,
    },
    null,
    2
  ) + '\n'
);
if (failures.length) console.log(`${failures.length} failed call(s); see failures in report.json`);
console.log(`${mp3}\n${calls.length} calls, ${(report.durationMs / 1000).toFixed(1)} s audio, ${(report.wallMs / 1000).toFixed(1)} s wall`);
