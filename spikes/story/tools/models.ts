import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: readFileSync(`${homedir()}/.config/mdmedia/gemini-key`, 'utf8').trim() });
const pager = await ai.models.list({ config: { pageSize: 200 } });
for await (const m of pager) if (/image|lyria|tts|imagen/i.test(m.name ?? '')) console.log(m.name, '|', (m.supportedActions ?? []).join(','));
