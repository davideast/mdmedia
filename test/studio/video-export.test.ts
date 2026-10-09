import { expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runVideoExport } from '../../studio/src/lib/video-export-runner';
import { readMp4Duration } from '../../src/video/mp4-duration';
import type { VideoJob } from '../../studio/src/lib/video-generation';

it('exports hard cuts by default, renders only selected fades and preserves per-clip mute',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'mdmedia-export-test-'));
  const encoder=path.resolve('studio/node_modules/ffmpeg-static/ffmpeg');const execute=promisify(execFile);
  const prior=process.env.FFMPEG_BIN;process.env.FFMPEG_BIN=encoder;
  try{
    const sources=new Map<string,Uint8Array>();
    for(const [index,color] of ['red','blue'].entries()){
      const file=path.join(directory,`${color}.mp4`);
      await execute(encoder,['-hide_banner','-nostdin','-f','lavfi','-i',`color=c=${color}:s=160x90:r=24:d=1.5`,'-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1.5','-c:v','libx264','-c:a','aac','-shortest','-y',file]);
      sources.set(String(index),await readFile(file));
    }
    for(const fade of [false,true]) {
    let output:Uint8Array|undefined;const patches:Partial<VideoJob>[]=[];
    await runVideoExport({id:'test-export',frame:'16:9',clips:[{videoId:'0',inSeconds:0.5,outSeconds:1,muted:true,...(fade?{transition:'fade' as const,transitionSeconds:0.25}:{})},{videoId:'1',inSeconds:0.25,outSeconds:1.25,muted:false}]},{read:async id=>sources.get(id)!,save:async bytes=>{output=bytes;},update:async patch=>{if(patch.status==='ready')expect(output).toBeDefined();patches.push(patch);}});
    expect(patches.at(-1)?.status).toBe('ready');expect(readMp4Duration(output!)).toBeCloseTo(fade?1.25:1.5,1);
    const file=path.join(directory,'final.mp4');await writeFile(file,output!);
    const pixel=async(time:string)=>{
      const result=await execute(encoder,['-hide_banner','-nostdin','-ss',time,'-i',file,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'});return [...result.stdout];
    };
    const red=await pixel('0.2'),blue=await pixel('0.8');expect(red[0]).toBeGreaterThan(red[2]+100);expect(blue[2]).toBeGreaterThan(blue[0]+100);
    const level=async(time:string)=>{
      const {stdout}=await execute(encoder,['-hide_banner','-nostdin','-ss',time,'-i',file,'-t','0.1','-vn','-f','s16le','pipe:1'],{encoding:'buffer'});
      let total=0;for(let i=0;i<stdout.length;i+=2)total+=Math.abs(stdout.readInt16LE(i));return total/(stdout.length/2);
    };
    if(fade){const blend=await pixel('0.375');expect(blend[0]).toBeGreaterThan(50);expect(blend[2]).toBeGreaterThan(50);}
    expect(await level('0.1')).toBeLessThan(2);expect(await level('0.8')).toBeGreaterThan(100);
    }
  }finally{if(prior===undefined)delete process.env.FFMPEG_BIN;else process.env.FFMPEG_BIN=prior;await rm(directory,{recursive:true,force:true});}
},30000);

it('mixes a pinned narration take at its chosen time into a muted video',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'mdmedia-audio-placement-'));const encoder=path.resolve('studio/node_modules/ffmpeg-static/ffmpeg');const execute=promisify(execFile);const prior=process.env.FFMPEG_BIN;process.env.FFMPEG_BIN=encoder;
 try{
  const source=path.join(directory,'video.mp4'),audio=path.join(directory,'voice.wav');
  await execute(encoder,['-hide_banner','-nostdin','-f','lavfi','-i','color=c=black:s=160x90:r=24:d=2','-c:v','libx264','-y',source]);
  await execute(encoder,['-hide_banner','-nostdin','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-y',audio]);
  let output:Uint8Array|undefined;let status='';let sourceId='';
  await runVideoExport({id:'mix',frame:'16:9',clips:[{videoId:'clip',inSeconds:0,outSeconds:2,muted:true}],audio:[{id:'placed',narrationId:'pinned-take',title:'Voice',startSeconds:.5,inSeconds:0,outSeconds:1,volume:.5,muted:false}]},{read:async()=>readFile(source),readAudio:async id=>{sourceId=id;return readFile(audio);},save:async bytes=>{output=bytes;},update:async patch=>{if(patch.status)status=patch.status;}});
  expect(status).toBe('ready');expect(sourceId).toBe('pinned-take');expect(readMp4Duration(output!)).toBeCloseTo(2,1);
  const result=path.join(directory,'mixed.mp4');await writeFile(result,output!);
  const level=async(time:string)=>{const {stdout}=await execute(encoder,['-hide_banner','-nostdin','-ss',time,'-i',result,'-t','0.1','-vn','-f','s16le','pipe:1'],{encoding:'buffer'});let sum=0;for(let i=0;i<stdout.length;i+=2)sum+=Math.abs(stdout.readInt16LE(i));return sum/(stdout.length/2);};
  expect(await level('0.1')).toBeLessThan(2);expect(await level('0.8')).toBeGreaterThan(100);expect(await level('1.8')).toBeLessThan(2);
 }finally{if(prior===undefined)delete process.env.FFMPEG_BIN;else process.env.FFMPEG_BIN=prior;await rm(directory,{recursive:true,force:true});}
},30000);

it('renders literal editorial captions only during their scheduled interval',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'mdmedia-caption-'));const encoder=path.resolve('studio/node_modules/ffmpeg-static/ffmpeg');const execute=promisify(execFile);const prior=process.env.FFMPEG_BIN;process.env.FFMPEG_BIN=encoder;
 try{
  const source=path.join(directory,'black.mp4');await execute(encoder,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=1280x720:r=24:d=2','-c:v','libx264',source]);
  let output:Uint8Array|undefined;let status='';
  await runVideoExport({id:'caption',frame:'16:9',clips:[{videoId:'source',inSeconds:0,outSeconds:2,muted:true}],captions:[{text:'Room: 74°F — 100%',start:.5,end:1.5}]},{read:async()=>readFile(source),save:async bytes=>{output=bytes;},update:async patch=>{if(patch.status)status=patch.status;}});
  expect(status).toBe('ready');const file=path.join(directory,'captioned.mp4');await writeFile(file,output!);
  const brightness=async(time:string)=>{const {stdout}=await execute(encoder,['-hide_banner','-loglevel','error','-ss',time,'-i',file,'-frames:v','1','-vf','crop=600:150:0:550','-f','rawvideo','-pix_fmt','gray','pipe:1'],{encoding:'buffer'});return [...stdout].reduce((a,b)=>a+b,0);};
  expect(await brightness('0.2')).toBe(0);expect(await brightness('0.9')).toBeGreaterThan(1000);expect(await brightness('1.8')).toBe(0);
 }finally{if(prior===undefined)delete process.env.FFMPEG_BIN;else process.env.FFMPEG_BIN=prior;await rm(directory,{recursive:true,force:true});}
},30000);
