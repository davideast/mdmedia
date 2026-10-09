import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import original from './fixtures/breakfast.plan.json';
import measured from './fixtures/breakfast.evidence.json';
import { audiencePass, movieHeader } from './helpers';
import { parseProductionPlan, parseProductionEvidence, productionPlanHash, hashProductionFile, REVIEW_CATEGORIES } from '../../src/production';

test('CLI reports separate readiness and preserves local editorial rejection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'production-cli-'));
  try{
    const plan=parseProductionPlan(structuredClone(original)),evidence=parseProductionEvidence(structuredClone(measured));
    for(const asset of plan.assets){
      asset.path=join(dir,asset.id+(asset.kind==='video'?'.mp4':'.jpg'));
      const duration=asset.id==='render'?28.25:plan.takes.find(t=>t.assetId===asset.id)?.duration??1;
      await writeFile(asset.path,asset.kind==='video'?movieHeader(duration):Buffer.from('test image'));
      asset.sha256=await hashProductionFile(asset.path);
    }
    for(const speech of evidence.speech)speech.assetHash=plan.assets.find(a=>a.id===plan.takes.find(t=>t.id===speech.takeId)?.assetId)!.sha256!;
    evidence.reviews=[{version:1,planHash:productionPlanHash(plan),stage:'edit',targetId:plan.id,assetHash:plan.assets.find(a=>a.id==='render')!.sha256,reviewer:'TEST DOUBLE',checks:REVIEW_CATEGORIES.map(category=>({category,verdict:'pass',evidence:'Test-only review coverage.'})),audience:audiencePass()}];
    const input=join(dir,'plan.json'),ev=join(dir,'evidence.json'),out=join(dir,'report.json');
    await writeFile(input,JSON.stringify(plan));await writeFile(ev,JSON.stringify(evidence));
    const run=()=>Bun.spawnSync([process.execPath,resolve('src/bin.ts'),'production','lint','--input',input,'--root',dir,'--stage','edit','--evidence',ev,'--json','--output',out],{env:{...process.env,GEMINI_API_KEY:''}});
    const ready=run();expect(ready.exitCode).toBe(0);expect(JSON.parse(ready.stdout.toString()).status).toBe('ready');
    expect(JSON.parse(ready.stdout.toString()).readiness).toEqual({technical:'valid',editorial:'passed'});
    expect(JSON.parse(await readFile(out,'utf8')).durationSeconds).toBe(28.25);
    const plain=Bun.spawnSync([process.execPath,resolve('src/bin.ts'),'production','lint','--input',input,'--root',dir,'--stage','edit','--evidence',ev]);
    expect(plain.stdout.toString()).toContain('READY FOR USER REVIEW');
    expect(plain.stdout.toString()).toContain('Technical: valid · Editorial: passed');
    const feedback=(extra:string[]=[])=>Bun.spawnSync([process.execPath,resolve('src/bin.ts'),'production','feedback','--input',input,'--root',dir,'--stage','edit','--evidence',ev,'--output',ev,'--message','The ending falls apart.','--repair','Establish the stakes and responses before the reveal.',...extra],{env:{...process.env,GEMINI_API_KEY:''}});
    expect(feedback().exitCode).toBe(0);
    const saved=parseProductionEvidence(JSON.parse(await readFile(ev,'utf8')));
    expect(saved.reviews).toEqual(evidence.reviews);expect(saved.speech).toEqual(evidence.speech);
    expect(saved.feedback?.[0].evidence).toBe('The ending falls apart.');
    expect(saved.feedback?.[0].assetHash).toBe(plan.assets.find(a=>a.id==='render')!.sha256);
    const rejected=run();expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout.toString()).readiness).toEqual({technical:'valid',editorial:'blocked'});
    plan.title='Renamed without fixing the film';await writeFile(input,JSON.stringify(plan));
    expect(JSON.parse(run().stdout.toString()).issues.some((i:{code:string})=>i.code==='EDITORIAL_FEEDBACK')).toBe(true);
    expect(feedback(['--stage','takes','--take','unknown']).exitCode).not.toBe(0);
    const render=plan.assets.find(a=>a.id==='render')!;const originalHash=render.sha256;
    render.sha256='a'.repeat(64);await writeFile(input,JSON.stringify(plan));
    expect(feedback().exitCode).not.toBe(0);
    expect(JSON.parse(await readFile(ev,'utf8')).feedback).toHaveLength(1);
    render.sha256=originalHash;await writeFile(input,JSON.stringify(plan));
    evidence.reviews=[];await writeFile(ev,JSON.stringify(evidence));const pending=run();expect(pending.exitCode).toBe(2);expect(JSON.parse(pending.stdout.toString()).status).toBe('needs-review');
    plan.shots[1].in=1.5;await writeFile(input,JSON.stringify(plan));const blocked=run();expect(blocked.exitCode).toBe(1);expect(JSON.parse(blocked.stdout.toString()).issues.some((i:{code:string})=>i.code==='CLIPPED_DIALOGUE')).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
