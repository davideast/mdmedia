/** Rebuild the portable plan from accepted edit decisions; never generates or changes media. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { hashProductionFile, productionPlanHash, type ProductionPlan, type ProductionTake, type ProductionEvidence } from '../src/production/index';
const root = '.design/beneath-double-coat/breakfast-exchange';
const output = 'test/production/fixtures';
const edit: {file:string;start:number;end:number;label:string}[] = JSON.parse(await readFile(`${root}/edit-bella-context.json`, 'utf8'));
const plan: ProductionPlan = {
  version: 2, id: 'alpenrose-breakfast', title: 'Accepted breakfast exchange — 28.25s excerpt of the 53.125s opening',
  constraints: { forbiddenVisible: ['humans', 'human hands', 'additional dogs', 'Bella appearing on camera'], maxWordsPerSecond: 5, minTakeSeconds: 3, maxTakeSeconds: 10 },
  assets: [],
  characters: [
    { id: 'sadie', description: 'Adult female Bernese; green collar; narrow blaze; Bruno’s wife.', voice: 'Controlled medium-low adult female, neutral English.', silent: false },
    { id: 'bruno', description: 'Adult male Bernese; navy collar; broad white chest; Sadie’s husband.', voice: 'Warm adult male baritone, neutral English.', silent: false },
  ],
  facts: [
    ['married', 'The preceding accepted opening says Bruno’s wife is waiting in the breakfast room.'],
    ['room', 'Sadie and Bruno sit across untouched cheese in the snowy estate breakfast room.'],
    ['late', 'Bruno returned after midnight, upsetting Sadie.'], ['walk', 'He claims he went for a walk.'],
    ['cheese', 'Sadie smells Parmesan on him.'], ['herb', 'Rosemary gives her a clue.'],
    ['bella-name', 'Sadie recognizes Bella.'], ['bella-ex', 'Bella is Bruno’s ex.'], ['snack', 'Bruno says Bella offered him a snack.'],
    ['absurdity', 'The snack kept him out until midnight.'], ['payoff', 'Bruno sincerely prioritizes good cheese over his weak excuse.'],
  ].map(([id,description]) => ({ id,description })),
  initialFacts: ['married'],
  scenes: [{ id: 'breakfast', location: 'Alpenrose breakfast room, winter morning', situation: 'Sadie confronts her husband about his late return.', purpose: 'Establish the marriage conflict and expose Bruno’s food-driven excuse.', orientationFact: 'room' }],
  dialogue: [], takes: [], shots: [], renderAssetId: 'render',
};
const intervals: Record<string, [string,string,string,number,number][]> = {
  'sadie-performance': [ ['late','sadie','You came home after midnight.',0.714,2.485], ['cheese','sadie','Then why do you smell like Parmesan?',4.658,6.74] ],
  'bruno-excuse': [ ['walk','bruno','I went for a walk.',1.228,2.142] ],
  'sadie-rosemary-performance': [ ['herb','sadie','And rosemary.',0.49,1.323], ['bella-name','sadie','Bella.',3.095,3.434], ['bella-ex','sadie','Your ex.',5.755,6.456], ['absurdity','sadie','And you stayed until midnight?',7.295,8.557] ],
  'bruno-bella-performance': [ ['sadie-reply','bruno','Sadie...',0.81,1.276], ['snack','bruno','She offered me a snack.',3,4.276], ['payoff','bruno','It was very good cheese.',6.159,7.62] ],
};
const state = { location: 'breakfast room', weather: 'snow outside', light: 'warm morning', cheese: 'untouched on plate', sadie: 'seated left', bruno: 'seated right' };
async function addAsset(id:string, path:string, kind:'image'|'video') {
  plan.assets.push({ id,path,kind,sha256:await hashProductionFile(path) });
}
for (const id of ['breakfast-establish','sadie-performance','bruno-excuse','sadie-rosemary-performance','bruno-bella-performance']) {
  await addAsset(id,`${root}/${id}.mp4`,'video');
  const newer = id.includes('rosemary') || id.includes('bella');
  const sadie = id.startsWith('sadie');
  const wide = id === 'breakfast-establish';
  const take: ProductionTake = {
    id,sceneId:'breakfast',setupId:wide?'master':sadie?'sadie-close':'bruno-close',method:newer?'first-frame':'reuse',
    duration:wide?3:newer?10:sadie?9:4,assetId:id,referenceAssetIds:[],
    camera:{size:wide?'two-shot':'close-up',angle:'Eye level; established conversation axis',movement:'Locked camera'},
    cast:wide?[{characterId:'sadie',position:'left',eyeline:'right'},{characterId:'bruno',position:'right',eyeline:'left'}]:[{characterId:sadie?'sadie':'bruno',position:sadie?'left':'right',eyeline:sadie?'right':'left'}],
    startState:{...state},endState:{...state},stateChanges:[],
    actions:[{description:wide?'Settled silent reaction across untouched cheese.':'Small canine eye, head and speaking-jaw movements; no prop handling.',risk:'low'}],
    dialogue:(intervals[id]??[]).map(([lineId,speaker,text,start,end])=>{
      plan.dialogue.push({id:lineId,speaker,text});
      return {lineId,start,end,visibility:'on-camera' as const};
    }),sound:'Quiet continuous breakfast room ambience; no music or additional voices.',
  };
  if(newer){
    const frame=sadie?'sadie-rosemary-first':'bruno-bella-first';
    await addAsset(frame,`${root}/${frame}.jpg`,'image');
    take.firstFrame={assetId:frame,fromTakeId:sadie?'sadie-performance':'bruno-excuse',at:sadie?7.708333333333333:2.9583333333333335};
  }
  plan.takes.push(take);
}
const functions: ProductionPlan['shots'][number]['purpose'][]=['establish','question','answer','question','escalation','reaction','escalation','reaction','escalation','answer','question','payoff','reaction'];
const established=['room','late','walk','cheese','herb',null,'bella-name',null,'bella-ex','snack','absurdity','payoff',null];
const required=[['married'],['room','married'],['late'],['walk'],['cheese'],['herb'],['herb'],['bella-name'],['bella-name'],['bella-ex'],['snack','late'],['absurdity'],['payoff']];
plan.shots=edit.map((cut,i)=>{
  const takeId=basename(cut.file,'.mp4'), factId=established[i];
  return {
    id:`shot-${String(i+1).padStart(2,'0')}`,takeId,in:cut.start,out:cut.end,purpose:functions[i],requires:required[i],
    establishes:factId?[{factId,evidence:cut.label,...(factId==='room'?{}:{lineId:factId})}]:[],
    transition:{type:i===0?'opening':i===4?'continuous':'cut',reason:cut.label,bridge:i===0?'establishing':functions[i]==='reaction'?'reaction':i===4?'same-space':'dialogue',stateExceptions:[]},
  };
});
await addAsset('render',`${root}/breakfast-bella-context.mp4`,'video');
const evidence:ProductionEvidence={version:1,reviews:[],speech:[]};
for(const take of plan.takes)for(const [lineId,speaker,text,start,end] of intervals[take.id]??[]){
  evidence.speech.push({takeId:take.id,assetHash:plan.assets.find(a=>a.id===take.assetId)!.sha256!,lineId,start,end,text,speaker,confidence:'confirmed'});
}
// Human acceptance is recorded only as context; do not fabricate category-by-category review passes.
await mkdir(output,{recursive:true});
await writeFile(`${output}/breakfast.plan.json`,JSON.stringify(plan,null,2)+'\n');
await writeFile(`${output}/breakfast.evidence.json`,JSON.stringify(evidence,null,2)+'\n');
console.log(`Wrote breakfast plan ${productionPlanHash(plan)} with measured source speech; category reviews still required.`);
