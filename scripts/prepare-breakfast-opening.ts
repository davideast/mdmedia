/** Bind the audited opening prompts to a fresh local Studio checkpoint; no provider calls. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compilePlan,type ProductionPlan} from './compile-production-plan';
import {projectDrafts,readProjectImport} from '../studio/src/lib/studio-project';
const checkpoint=process.argv[2];
if(!checkpoint)throw Error('Supply a new checkpoint path.');
const plan:ProductionPlan=JSON.parse(await readFile('drafts/beneath-double-coat/breakfast-production-plan.json','utf8'));
if(createHash('sha256').update(await readFile(plan.screenplay.path)).digest('hex')!==plan.screenplay.sha256)throw Error('Screenplay changed; reconcile plan first.');
const requests=compilePlan(plan).requests.slice(0,4);
if(requests.some(r=>r.requiredPostproduction.length))throw Error('This build runner cannot execute editorial dialogue synchronization.');
const manifest=readProjectImport(JSON.parse(await readFile('.design/beneath-double-coat/breakfast-opening/project.json','utf8')));
const {id:draftId,record}=projectDrafts(manifest)[0];
record.draft.mode='references';record.draft.note='';
for(const request of requests){
 const beat=record.draft.beats.find(b=>b.id===`script_${request.shotId}`);
 if(!beat||beat.start===null||beat.end===null||beat.end-beat.start!==request.durationSeconds)throw Error('Compiled request and timeline differ.');
 beat.text=request.prompt;
}
await writeFile(checkpoint,JSON.stringify({origin:'http://127.0.0.1:3101',draftId,record,jobs:{},retries:{}},null,2),{mode:0o600,flag:'wx'});
console.log('Prepared four exact compiled prompts; continuation chain s01 → s02 → s03; referenced hard cut to s04. No generation submitted.');
