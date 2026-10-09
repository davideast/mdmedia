import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {createGeminiClient} from '../../../src/tts/gemini-client-factory';
const dir='.design/beneath-double-coat/breakfast-exchange';
const fragments=[
 {source:'sadie-rosemary-performance',start:0,end:1.65},
 {source:'sadie-rosemary-performance',start:2.8,end:3.7},
 {source:'sadie-rosemary-performance',start:3.7,end:5.5},
 {source:'sadie-rosemary-performance',start:5.5,end:6.75},
 {source:'sadie-rosemary-performance',start:7,end:8.9},
 {source:'bruno-bella-performance',start:0.5,end:1.65},
 {source:'bruno-bella-performance',start:2.75,end:4.65},
 {source:'bruno-bella-performance',start:5.9,end:8},
];
const parts:any[]=[{text:'Transcribe each attached short audio fragment VERBATIM, separately. No intended screenplay is supplied. Do not add words to repair incomplete sentences. If silent say [silence]. Return JSON array of {fragment, words}. These are excerpts from talking-animal dialogue. Listen only to the audio, do not infer a story.'}];
for(const [index,f] of fragments.entries()){
 const path=`${dir}/bella-audio-fragment-${index}.wav`;
 await promisify(execFile)('studio/node_modules/ffmpeg-static/ffmpeg',['-hide_banner','-loglevel','error','-ss',String(f.start),'-i',`${dir}/${f.source}.mp4`,'-t',String(f.end-f.start),'-vn','-ar','24000','-ac','1','-y',path]);
 parts.push({text:`Fragment ${index}: ${f.source} seconds ${f.start}–${f.end}`},{inlineData:{mimeType:'audio/wav',data:(await readFile(path)).toString('base64')}});
}
const response=await createGeminiClient().models.generateContent({model:'gemini-3.1-pro-preview',contents:[{role:'user',parts}],config:{responseMimeType:'application/json',abortSignal:AbortSignal.timeout(180000)}});
await writeFile(`${dir}/bella-audio-fragments.json`,response.text??'{}');
console.log(response.text);
