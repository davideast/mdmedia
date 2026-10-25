import {describe,it,expect} from 'bun:test';
import {readFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {resolveCutJson} from '../../src/cut/index';
const read=(n:string)=>JSON.parse(readFileSync(new URL('../../docs/cuts/'+n,import.meta.url),'utf8'));
const original=read('football-take2-draft5.cut.json'),edited=read('football-take2-editorial1.cut.json');
const resolve=(c:unknown)=>{const r=resolveCutJson(c);if(!r.ok)throw Error(JSON.stringify(r.errors));return r.value};
const a=resolve(original),b=resolve(edited);
const item=(items:any[],id:string)=>items.find(x=>x.id===id);
describe('Football editorial pass: preserve the performances',()=>{
 it('retains every word, take, source in/out and order, with one uninterrupted callback performance',()=>{
  expect(edited.lines.map((l:any)=>[l.id,l.speaker,l.text])).toEqual(original.lines.map((l:any)=>[l.id,l.speaker,l.text]));
  for(const old of original.lines){const next=item(edited.lines,old.id);expect([next.in,next.out]).toEqual([old.in,old.out]);if(old.id==='m_close')expect(edited.sources[next.src].extendedFrom).toBe(old.src);else expect(next.src).toBe(old.src);}
  expect(edited.lines.filter((l:any)=>l.id==='m_close')).toHaveLength(1);
  expect(item(edited.lines,'m_close').src).toContain('lifted.wav');
 });
 it('preserves every dialogue timing up to the kick, then shifts all remaining lines exactly a quarter second',()=>{
  for(const old of a.lines){const next=item(b.lines,old.id),shift=['c_kick','c_close','m_close'].includes(old.id)?0.25:0;expect(next.start-old.start).toBeCloseTo(shift,8);expect(next.end-old.end).toBeCloseTo(shift,8)}
  expect(b.length).toBeCloseTo(63.55,8);
 });
 it('keeps the touchdown speech on the return picture and delays its crowd swell until touchdown',()=>{
  const kick=item(b.segments,'kick'),roar=item(b.sfx,'roar_c');expect(kick.start).toBeGreaterThan(45.4);expect(kick.start).toBeCloseTo(45.58,8);expect(roar.start).toBeCloseTo(44.86,8);
  expect(item(b.segments,'scoop').out).toBe(3.7);
 });
 it('lifts only the repetition, leaving the first delivery and its pause intact',()=>{
  const ff=new URL('../../node_modules/ffmpeg-static/ffmpeg',import.meta.url).pathname;
  const decode=(p:string)=>{const r=spawnSync(ff,['-v','error','-i',p,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],{maxBuffer:8000000});expect(r.status).toBe(0);return r.stdout};
  const originalPath=path.join(os.homedir(),'.local/share/mdmedia/productions/crt-tv/takes/fb2-m-close-t3.mp4'),liftedPath=path.join(os.homedir(),'.local/share/mdmedia/productions/crt-tv/editorial/football-take2-20261020/fb2-m-close-t3-lifted.wav');
  if(existsSync(originalPath)&&existsSync(liftedPath)){const original=decode(originalPath),lifted=decode(liftedPath);
  expect(lifted.length).toBe(original.length);
  for(const [start,end,gain] of [[0,3.5,1],[4.05,6,10**(2/20)]]){let maxError=0;for(let i=Math.ceil(start*48000);i<end*48000;i++)maxError=Math.max(maxError,Math.abs(lifted.readFloatLE(i*4)-original.readFloatLE(i*4)*gain));expect(maxError).toBeLessThan(0.000001)}
  }
  const sourceWords=read('football-take2-editorial1.words.json').lines.m_close.words;expect(sourceWords).toEqual(read('football-take2-draft5.words.json').lines.m_close.words);
  const repeat=sourceWords[7].start,firstEnd=sourceWords[6].end;expect(repeat-firstEnd).toBeCloseTo(1.1,5);
 });
 it('preserves score and booth continuity after the shift',()=>{
  expect(item(b.overlays,'strip_win').start-item(a.overlays,'strip_win').start).toBeCloseTo(.25,8);
  for(const id of ['close','mclose']){const s=item(b.segments,id),l=item(b.lines,id==='close'?'c_close':'m_close');expect(s.start).toBe(l.start)}
  expect(item(b.music,'sting').start).toBe(item(b.segments,'outro').start);
 });
 it('keeps the original end-zone limitation visible rather than substituting a different player',()=>{
  expect(edited.segments.map((s:any)=>s.src)).toEqual(original.segments.map((s:any)=>s.src));
  expect(edited.meta.notes).toContain('unseen');
 });
});
