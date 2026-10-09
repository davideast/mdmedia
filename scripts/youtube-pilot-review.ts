import {readFile,writeFile} from 'node:fs/promises';
import {createGeminiClient} from '../src/tts/gemini-client-factory';
const dir='.design/youtube-pilot';
const bytes=await readFile(`${dir}/terminal-hollywood-opening.mp4`);
const result=await createGeminiClient().models.generateContent({model:'gemini-3.5-flash-lite',contents:[{role:'user',parts:[{inlineData:{mimeType:'video/mp4',data:bytes.toString('base64')}},{text:'Critically review this thirty-second YouTube opening. Return JSON with actual spoken transcript broken into phrases with start/end seconds; any cut-off words; visual sequence description; whether presenter speech matches visible lip movements; whether the terminal text is readable; whether music masks dialogue; whether the wrong-engine joke is audible and timed correctly; black frames/frozen or missing images; three concrete editing weaknesses. Do not flatter. Describe what you actually hear and see. Terminal sequences are explicitly replays of real CLI output with waits removed.'}]}],config:{responseMimeType:'application/json',abortSignal:AbortSignal.timeout(120000)}});
await writeFile(`${dir}/edit-review.json`,result.text??'{}');console.log(result.text);
