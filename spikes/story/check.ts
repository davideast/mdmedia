// Throwaway: has Gemini listen to a render against its story file and list
// mechanical problems, so a person only listens for what code can't judge.
//
//   bun spikes/story/check.ts spikes/story/earnest-act-1.md line

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createGeminiClient } from '../../src/tts/gemini-client-factory.js';

const [file, mode = 'line', model = 'gemini-3.5-flash'] = Bun.argv.slice(2);
if (!file) {
  console.error('usage: bun spikes/story/check.ts <story.md> [line|run] [model]');
  process.exit(2);
}

const name = basename(file, '.md');
const dir = join(import.meta.dir, 'out', name, mode);
const key = process.env.GEMINI_API_KEY ?? readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim();

// 32 kb/s mono keeps a 12-minute render well under the inline request limit.
const small = join(process.env.TMPDIR ?? tmpdir(), `${name}-${mode}-check.mp3`);
const ffmpeg = resolve(import.meta.dir, '../../node_modules/ffmpeg-static/ffmpeg');
const ff = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', join(dir, `${name}.mp3`), '-ac', '1', '-ar', '16000', '-b:a', '32k', small]);
if (ff.status !== 0) throw new Error('ffmpeg failed');

const prompt = `You are checking an audio drama render against its script.
The script is a markdown file. Front matter lists the cast and their voices.
Lines written as **NAME** *(cue)*: text are spoken by NAME with that delivery;
other paragraphs are spoken by the narrator. Pause blocks are silences.
Headings are not spoken.

Listen to the whole recording and report only real problems, each with an
approximate mm:ss timestamp:

- "spoken-markup": a speaker name, "NARRATOR", a bracketed cue or stage
  direction read aloud.
- "wrong-voice": a line spoken in the wrong character's voice, or a voice
  that changes character mid-scene.
- "text": words skipped, added, repeated, or garbled.
- "cut-off": a line that ends abruptly.
- "cue-missed": a line whose written cue clearly did not come through
  (for example a whisper spoken at full volume).

Then give a short "notes" paragraph on how natural the scene sounds as
drama: pacing, turn-taking, whether emotion builds. Be specific and brief.

Return JSON: {"problems":[{"type","at","line","detail"}],"notes":""}

SCRIPT:
${readFileSync(file, 'utf8')}`;

const client = createGeminiClient({ getApiKey: () => key });
const started = performance.now();
// Busy-model errors (503, 429) are common; retry with backoff.
async function generate(request: Parameters<typeof client.models.generateContent>[0]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.models.generateContent(request);
    } catch (error: any) {
      if (attempt >= 5 || ![429, 500, 503].includes(error?.status)) throw error;
      await Bun.sleep(2000 * 2 ** attempt);
    }
  }
}
const response = await generate({
  model,
  contents: [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/mp3', data: readFileSync(small).toString('base64') } },
        { text: prompt },
      ],
    },
  ],
  config: { responseMimeType: 'application/json' },
});

const text = response.text ?? '';
const out = join(dir, 'check.json');
let parsed: unknown;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = { raw: text };
}
writeFileSync(out, JSON.stringify({ model, ms: Math.round(performance.now() - started), ...(parsed as object) }, null, 2) + '\n');
console.log(out);
