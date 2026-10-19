// Throwaway: verbatim transcript of an MP3, to search for leaked cues or names.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
const [mp3, out, model = 'gemini-3.5-flash-lite'] = Bun.argv.slice(2);
const ai = new GoogleGenAI({ apiKey: readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim() });
const r = await ai.models.generateContent({ model, contents: [{ role: 'user', parts: [
  { inlineData: { mimeType: 'audio/mp3', data: readFileSync(mp3!).toString('base64') } },
  { text: 'Transcribe this audio verbatim, word for word, exactly as spoken, including any words that sound like stage directions, speaker names or performance notes. Plain text, one paragraph per speaker turn, with a [mm:ss] timestamp at the start of each paragraph.' } ] }] });
writeFileSync(out!, r.text ?? '');
console.log(out);
