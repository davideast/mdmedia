import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {createGeminiClient} from '../../../src/tts/gemini-client-factory';
const dir='.design/beneath-double-coat/penny-introduction';
const fragments=[
 {source:'penny-performance',start:0.75,end:1.6},
 {source:'penny-performance',start:1.75,end:3.15},
 {source:'penny-performance',start:3.25,end:3.9},
 {source:'penny-performance',start:4.25,end:6.45},
 {source:'penny-performance',start:6.5,end:8},
 {source:'bruno-performance',start:0.5,end:3.8},
 {source:'sadie-performance',start:0.5,end:1.4},
 {source:'sadie-performance',start:1.85,end:4.4},
 {source:'sadie-performance',start:5,end:5.95},
 {source:'sadie-performance',start:6.1,end:7.8}
];
const parts:any[]=[{text:'Transcribe each attached short audio fragment VERBATIM, separately. No intended screenplay is supplied. Do not add words to repair incomplete sentences. If silent say [silence]; if a sigh/breath say [breath]. Return JSON array of {fragment, words, voiceDescription}. These are excerpts from talking-animal dialogue. Listen only to the actual audio, do not infer a story.'}];
for(const [index,f] of fragments.entries()){
 const path=`${dir}/audio-fragment-${index}.wav`;
 await promisify(execFile)('studio/node_modules/ffmpeg-static/ffmpeg',['-hide_banner','-loglevel','error','-ss',String(f.start),'-i',`${dir}/${f.source}.mp4`,'-t',String(f.end-f.start),'-vn','-ar','24000','-ac','1','-y',path]);
 parts.push({text:`Fragment ${index}`},{inlineData:{mimeType:'audio/wav',data:(await readFile(path)).toString('base64')}});
}
const response=await createGeminiClient().models.generateContent({model:'gemini-3.1-pro-preview',contents:[{role:'user',parts}],config:{responseMimeType:'application/json',abortSignal:AbortSignal.timeout(180000)}});
await writeFile(`${dir}/audio-fragments.json`,response.text??'{}');
await writeFile(`${dir}/audio-fragment-ranges.json`,JSON.stringify(fragments,null,2));
console.log(response.text);
