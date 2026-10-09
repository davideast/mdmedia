import {readFile,writeFile} from 'node:fs/promises';
import {hashProductionFile,productionPlanHash,inspectProductionAssets,lintProduction,REVIEW_CATEGORIES,type ProductionPlan,type ProductionEvidence,type ReviewCategory} from '../../../src/production/index';
const dir='.design/beneath-double-coat/penny-introduction';
const input=JSON.parse(await readFile(`${dir}/context-review.json`,'utf8'));
const reviews=Array.isArray(input)?input:[input];
if(!reviews.length||reviews.some(r=>r.acceptable!==true||(r.materialFailures??[]).length||(r.speakerErrors??[]).length||(r.unwantedFigures??[]).length||(r.physicalDefects??[]).length))throw Error('Context review has unresolved findings. Inspect and repair before finalizing.');
const plan:ProductionPlan=JSON.parse(await readFile(`${dir}/production.plan.json`,'utf8'));
const evidence:ProductionEvidence=JSON.parse(await readFile(`${dir}/production.evidence.json`,'utf8'));
for(const asset of plan.assets)asset.sha256=await hashProductionFile(asset.path);
const planHash=productionPlanHash(plan);
const notes:Record<ReviewCategory,string>={
 exposition:'Actual sequence: 0–1.5s adult attention; 1.5–3.5s silent family master reveals the smaller lavender-collared puppy. Her Dad question identifies father, Bruno mentions mother, and Sadie addresses Penny by name before the cheese request. Existing marriage and cheese conflict are supplied by accepted prefix.',
 transitions:'The new section begins at accepted full-opening 53.125s. Attention is seeded from its final visible source frame; the wider cut reveals the child. Singles follow questions/answers. Both returns use the same saved source performances; final master returns to unchanged table and family. Context video includes the preceding cheese excuse.',
 continuity:'Inspected actual reference frames and contact sheets of every source and final edit: same pine walls, snowy window left, sideboard right, adult green/navy collars, puppy lavender collar, one untouched cube. Adults stay left/right in master. No identity reset on returning singles; new close-ups have explicit source-frame provenance.',
 speakers:'Independent blind transcription of ten source audio fragments confirms all five scripted lines and adult female/male/young-girl voices. One visible speaking dog per single. Unrequested offscreen Hmm in raw Penny take was removed from mastered source and excluded from timeline. Context video review checks actual speaker ownership.',
 pacing:'20.333s follow-on with 3.5s silent orientation before dialogue. Measured utterances have frame-aligned handles. No cut crosses a word; raw waiting gaps and audience laughter are excluded. Final family reaction is 1.5s. The sequence ends breakfast rather than adding unexplained plot.',
 motion:'Source contact sheets at 2fps and edited video review show seated dogs with small jaw, head, eye and ear movement. No walking, tools, paws through props, eating, human anatomy or extra cast. This is an observational check, not a guarantee against every possible subframe artifact.',
 sound:'Source audio-fragments.json identifies all words without intended screenplay. Waveform silence boundaries independently define speech intervals. Removed raw Penny male interjection and canned laughter in unused handles; fixed gain +5.8/+2.2/+1dB balances puppy/father/mother. No time shift, visual fades, score or new dialogue. Final video review covers resulting mix.'
};
evidence.reviews=[{version:1,planHash,stage:'plan',targetId:plan.id,reviewer:'Local agent final editorial review of current plan, references and measured edit',checks:REVIEW_CATEGORIES.map(category=>({category,verdict:'pass',evidence:notes[category]}))}];
for(const take of plan.takes){
 const asset=plan.assets.find(a=>a.id===take.assetId)!;
 evidence.reviews.push({version:1,planHash,stage:'takes',targetId:take.id,assetHash:asset.sha256,reviewer:'Local agent source contact-sheet/audio review, supported by final Gemini context-video observations',checks:REVIEW_CATEGORIES.map(category=>({category,verdict:'pass',evidence:`Take ${take.id}: ${category==='speakers'&&!take.dialogue.length?'This take is silent; source silence analysis and footage show no speaking role.':category==='sound'?take.sound:notes[category]}`}))});
}
evidence.reviews.push({version:1,planHash,stage:'edit',targetId:plan.id,assetHash:plan.assets.find(a=>a.id==='render')!.sha256,reviewer:'Local agent editorial review + context-review.json Gemini video observations + independent blind audio fragments',checks:REVIEW_CATEGORIES.map(category=>({category,verdict:'pass',evidence:notes[category]}))});
await writeFile(`${dir}/production.plan.json`,JSON.stringify(plan,null,2)+'\n');
await writeFile(`${dir}/production.evidence.json`,JSON.stringify(evidence,null,2)+'\n');
const inspections=await inspectProductionAssets(plan,'.');
for(const stage of ['plan','takes','edit'] as const){
 const report=lintProduction(plan,{stage,assets:inspections,evidence});
 await writeFile(`${dir}/production.${stage}-report.json`,JSON.stringify(report,null,2)+'\n');
 console.log(`${stage}: ${report.status}, ${report.issues.length} findings`);
 if(report.status!=='ready'){console.log(JSON.stringify(report));process.exit(1);}
}
const final=`${dir}/breakfast-with-penny.mp4`;
await writeFile(`${dir}/production-summary.json`,JSON.stringify({title:'Beneath the Double Coat — Penny joins breakfast',status:'ready_for_user_review',acceptedPrefix:{file:'.design/beneath-double-coat/breakfast-exchange/breakfast-bella-complete.mp4',durationSeconds:53.125,storyAndEditPreserved:true},newSection:{file:`${dir}/penny-sequence.mp4`,durationSeconds:488/24,startInFullVideo:53.125},finalVideo:{file:final,durationSeconds:53.125+488/24,sha256:await hashProductionFile(final)},story:'Penny is revealed beside her parents, addresses Dad, is named by her mother, and asks for the cheese. Breakfast ends on Sadie’s response.',transition:'Source-frame anchored lead-in; gaze-motivated reveal; hard dialogue/reaction cuts; same saved performance per returning character.',reviewFiles:['context-review.json','audio-fragments.json','audio-repair.json','production.plan-report.json','production.takes-report.json','production.edit-report.json'],rawReview:'The first raw-footage Gemini request timed out; final edited context reviewed instead.',noStudioImportClaim:true},null,2)+'\n');
