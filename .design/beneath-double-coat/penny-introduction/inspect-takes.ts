import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
const dir='.design/beneath-double-coat/penny-introduction';
const run=promisify(execFile),ffmpeg='studio/node_modules/ffmpeg-static/ffmpeg';
const results=await Promise.all(['attention','family','penny-performance','bruno-performance','sadie-performance'].map(async id=>{
 await run(ffmpeg,['-hide_banner','-loglevel','error','-i',`${dir}/${id}.mp4`,'-vf','fps=2,scale=384:-1,tile=4x5','-frames:v','1','-y',`${dir}/${id}-contact.jpg`]);
 const {stderr}=await run(ffmpeg,['-hide_banner','-i',`${dir}/${id}.mp4`,'-af','silencedetect=noise=-35dB:d=0.15','-f','null','-']);
 await writeFile(`${dir}/${id}-silence.log`,stderr);
 return{id,silence:stderr.split('\n').filter(line=>line.includes('silence_'))};
}));
console.log(JSON.stringify(results,null,2));
