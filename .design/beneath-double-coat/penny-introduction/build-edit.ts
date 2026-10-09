import {readFile,writeFile} from 'node:fs/promises';
import {hashProductionFile,productionPlanHash,type ProductionPlan,type ProductionEvidence} from '../../../src/production/index';
const dir='.design/beneath-double-coat/penny-introduction';
const plan:ProductionPlan=JSON.parse(await readFile(`${dir}/production.plan.json`,'utf8'));
// Measured waveform/silence boundaries, with words independently checked from isolated audio.
const speech=[{takeId:'penny-performance',lineId:'trouble',start:0.971521,end:2.92856},{takeId:'penny-performance',lineId:'cheese',start:4.5051,end:6.215},{takeId:'bruno-performance',lineId:'breakfast',start:0.745042,end:3.5135},{takeId:'sadie-performance',lineId:'subject',start:0.744062,end:4.13675},{takeId:'sadie-performance',lineId:'enough',start:5.26769,end:7.47423}];
for(const id of ['penny','bruno','sadie']){
 const asset=plan.assets.find(a=>a.id===`${id}-performance`)!;
 asset.path=`${dir}/${id}-mastered.mp4`;
 const take=plan.takes.find(t=>t.id===asset.id)!;
 take.dialogue=take.dialogue.map(cue=>({...cue,...{start:speech.find(s=>s.lineId===cue.lineId)!.start,end:speech.find(s=>s.lineId===cue.lineId)!.end}}));
 if(id==='penny'){take.cast[0].position='left';take.sound='Original young-girl dialogue retained; unused 3.2–4.3s and 6.5–8s muted to remove unrequested offscreen male hmm and audience laughter. +5.8dB level correction. No source time shift.';}
 if(id==='bruno')take.sound='Original adult male dialogue, +2.2dB fixed gain; quiet room tone; no source time shift.';
 if(id==='sadie')take.sound='Original adult female dialogue, +1dB fixed gain; quiet room tone; no source time shift.';
}
plan.takes.find(t=>t.id==='attention')!.sound='Very quiet room tone. No audible collar tick was generated; parents’ visual attention motivates reveal.';
const frames:Record<string,[number,number]>={attention:[0,36],reveal:[0,48],'penny-first':[16,76],'bruno-answer':[12,96],'sadie-names':[10,108],'penny-cheese':[102,155],'sadie-payoff':[120,193],'family-ending':[36,72]};
for(const shot of plan.shots){[shot.in,shot.out]=frames[shot.id].map(n=>n/24);if(shot.id==='attention'){shot.transition.bridge='gaze';shot.establishes[0].evidence='The seated adults shift attention down toward the near foreground; the next wider shot identifies the child.';}}
// Current rendered output is declared but will be pinned after rendering.
plan.assets=plan.assets.filter(a=>a.id!=='render');
for(const asset of plan.assets)asset.sha256=await hashProductionFile(asset.path);
plan.assets.push({id:'render',kind:'video',path:`${dir}/penny-sequence.mp4`});plan.renderAssetId='render';
const evidence:ProductionEvidence={version:1,reviews:[],speech:speech.map(s=>{const line=plan.dialogue.find(l=>l.id===s.lineId)!;return{...s,assetHash:plan.assets.find(a=>a.id===s.takeId)!.sha256!,speaker:line.speaker,text:line.text,confidence:'confirmed'};})};
await writeFile(`${dir}/production.plan.json`,JSON.stringify(plan,null,2)+'\n');
await writeFile(`${dir}/production.evidence.json`,JSON.stringify(evidence,null,2)+'\n');
const edit=plan.shots.map(s=>({file:plan.assets.find(a=>a.id===plan.takes.find(t=>t.id===s.takeId)!.assetId)!.path,start:s.in,end:s.out,label:`${s.id}: ${s.transition.reason}`}));
await writeFile(`${dir}/edit.json`,JSON.stringify(edit,null,2)+'\n');
await writeFile(`${dir}/audio-repair.json`,JSON.stringify({method:'Fixed gain and silence replacement in unused raw Penny handles; video copied, no timing changes.',gainsDb:{penny:5.8,bruno:2.2,sadie:1},removed:[{file:'penny-performance.mp4',from:3.2,to:4.3,reason:'Unrequested offscreen male Hmm, independently transcribed.'},{file:'penny-performance.mp4',from:6.5,to:8,reason:'Unrequested canned audience laughter, independently transcribed.'}],sourceAudioEvidence:'audio-fragments.json',timingEvidence:'*-silence.log',editEndsBeforeUnwantedAudio:true},null,2)+'\n');
console.log(`Prepared ${edit.reduce((t,c)=>t+c.end-c.start,0).toFixed(3)}s edit; plan ${productionPlanHash(plan)} awaiting final media review.`);
