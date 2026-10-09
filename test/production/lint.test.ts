import { describe, expect, test } from 'bun:test';
import original from './fixtures/breakfast.plan.json';
import measured from './fixtures/breakfast.evidence.json';
import { audiencePass } from './helpers';
import { lintProduction, parseProductionPlan, parseProductionEvidence, productionPlanHash, REVIEW_CATEGORIES, type ProductionPlan, type ProductionEvidence, type ProductionStage, type AssetInspection } from '../../src/production';

const example = () => parseProductionPlan(structuredClone(original));
const inventory = (p: ProductionPlan): AssetInspection[] => p.assets.map(a => ({ id:a.id,sha256:a.sha256,durationSeconds:a.id==='render'?28.25:p.takes.find(t=>t.assetId===a.id)?.duration }));
// Explicit test double for review coverage. Not a claim about real media or story quality.
function evidence(p:ProductionPlan,stage:ProductionStage='edit'):ProductionEvidence {
  const result=parseProductionEvidence(structuredClone(measured));
  const targets=stage==='takes'?p.takes.map(t=>({id:t.id,assetId:t.assetId})):[{id:p.id,assetId:stage==='edit'?p.renderAssetId:undefined}];
  result.reviews=targets.map(t=>({version:1,planHash:productionPlanHash(p),stage,targetId:t.id,assetHash:p.assets.find(a=>a.id===t.assetId)?.sha256,reviewer:'TEST DOUBLE',checks:REVIEW_CATEGORIES.map(category=>({category,verdict:'pass',evidence:'Test-only review coverage, not a real editorial assessment.'})),...(stage==='edit'?{audience:audiencePass()}: {})}));
  return result;
}
function check(p:ProductionPlan,stage:ProductionStage='edit',e=evidence(p,stage)) {return lintProduction(p,{stage,evidence:e,assets:inventory(p)});}
const codes=(p:ProductionPlan,stage:ProductionStage='edit')=>check(p,stage).issues.map(i=>i.code);

describe('production checks across accepted breakfast edit decisions',()=>{
  test('accepts reused performances, short reaction cuts, and evidence-supported pacing',()=>{
    const result=check(example());
    expect(result.status).toBe('ready');expect(result.durationSeconds).toBe(28.25);
    expect(result.resolvedIssues?.some(i=>i.code==='SPEECH_PACING')).toBe(true);
  });
  test('a structurally valid plan without editorial evidence is not marked ready',()=>{
    const p=example();const result=check(p,'plan',{version:1,reviews:[],speech:[]});
    expect(result.status).toBe('needs-review');expect(result.issues.filter(i=>i.code==='REVIEW_MISSING')).toHaveLength(REVIEW_CATEGORIES.length);
  });
  test('catches removing orientation and introductions before later beats depend on them',()=>{
    const p=example();p.shots[0].establishes=[];
    expect(codes(p)).toContain('LOCATION_UNESTABLISHED');expect(codes(p)).toContain('EXPOSITION_MISSING');
    const other=example();other.shots.find(s=>s.establishes.some(f=>f.factId==='bella-ex'))!.establishes=[];
    expect(codes(other)).toContain('EXPOSITION_MISSING');
  });
  test('a later introduction cannot justify an earlier dependent beat',()=>{
    const p=example();p.shots[1].requires.push('bella-ex');expect(codes(p)).toContain('EXPOSITION_MISSING');
  });
  test('exposition must cite dialogue actually included in that shot',()=>{
    const p=example();p.shots[0].establishes[0].lineId='payoff';expect(codes(p)).toContain('EXPOSITION_EVIDENCE');
  });
  test('requires exact source frames when returning to an established setup',()=>{
    const p=example();const t=p.takes.find(t=>t.id==='sadie-rosemary-performance')!;t.method='generate';delete t.firstFrame;t.referenceAssetIds=['sadie-rosemary-first'];
    expect(codes(p)).toContain('UNANCHORED_RETURN');
  });
  test('continuous label cannot conceal a mismatched predecessor ending',()=>{
    const p=example();p.takes.find(t=>t.id==='sadie-rosemary-performance')!.firstFrame!.at=3;
    expect(codes(p)).toContain('FALSE_CONTINUATION');
  });
  test('a frame of the wrong dog and changed return eyelines are rejected',()=>{
    const p=example();p.takes.find(t=>t.id==='sadie-rosemary-performance')!.firstFrame={assetId:'sadie-rosemary-first',fromTakeId:'bruno-excuse',at:1};
    expect(codes(p)).toContain('FRAME_CAST_OR_SET');
    const q=example();q.takes.find(t=>t.id==='bruno-bella-performance')!.cast[0].eyeline='right';expect(codes(q)).toContain('SETUP_DRIFT');
  });
  test('extension requires the actual previous take and ending state',()=>{
    const p=example();const t=p.takes.find(t=>t.id==='sadie-rosemary-performance')!;t.method='extend';delete t.firstFrame;
    expect(codes(p)).toContain('CONTINUATION_SOURCE');
    t.previousTakeId='sadie-performance';t.startState.cheese='eaten';
    expect(codes(p)).toContain('CONTINUATION_STATE');
  });
  test('references cannot point forward into a dependency cycle',()=>{
    const p=example();p.takes.find(t=>t.id==='sadie-rosemary-performance')!.firstFrame!.fromTakeId='bruno-bella-performance';
    expect(codes(p)).toContain('FRAME_ORIGIN');
  });
  test('catches wrong and absent on-camera speakers',()=>{
    const p=example();p.dialogue.find(d=>d.id==='herb')!.speaker='bruno';
    expect(codes(p)).toContain('SPEAKER_ABSENT');expect(codes(p)).toContain('SPEECH_MISMATCH');
    p.characters.find(c=>c.id==='bruno')!.silent=true;expect(codes(p)).toContain('SPEAKER_ROLE');
  });
  test('unrelated caller names do not change speaker ownership',()=>{
    const p=example();expect(p.dialogue.find(d=>d.id==='sadie-reply')!.speaker).toBe('bruno');expect(check(p).status).toBe('ready');
  });
  test('detects clipping actual speech even when planned timing fits the edit',()=>{
    const p=example();const t=p.takes.find(t=>t.id==='bruno-bella-performance')!;t.dialogue.find(c=>c.lineId==='payoff')!.start=6.9;
    p.shots.find(s=>s.purpose==='payoff')!.in=6.8;
    expect(codes(p,'plan')).not.toContain('CLIPPED_DIALOGUE');expect(codes(p)).toContain('CLIPPED_DIALOGUE');
  });
  test('does not allow omitted or duplicated dialogue',()=>{
    const p=example();p.shots=p.shots.filter(s=>s.purpose!=='payoff');expect(codes(p)).toContain('MISSING_DIALOGUE');
    const q=example();q.shots.push({...q.shots[1],id:'repeat',transition:{...q.shots[1].transition,type:'cut'}});expect(codes(q)).toContain('REPEATED_DIALOGUE');
  });
  test('measured words and source timing cannot be replaced by a generic model pass',()=>{
    const p=example();const e=evidence(p);e.speech[0].text='Invented dialogue';e.speech[1].confidence='estimated';
    expect(check(p,'edit',e).issues.map(i=>i.code)).toEqual(expect.arrayContaining(['SPEECH_MISMATCH','SPEECH_ESTIMATED']));
    e.speech=[];expect(check(p,'edit',e).status).toBe('needs-review');
  });
  test('detects prop changes across a cut',()=>{
    const p=example();p.takes.find(t=>t.id==='bruno-excuse')!.startState.cheese='missing';expect(codes(p)).toContain('CUT_STATE_JUMP');
  });
  test('new scene cannot use an unexplained same-space transition',()=>{
    const p=example();p.scenes.push({id:'garden',location:'Garden',situation:'Leaving breakfast',purpose:'Follow a lead',orientationFact:'room'});
    p.takes.find(t=>t.id==='bruno-excuse')!.sceneId='garden';p.shots[2].transition.bridge='same-space';expect(codes(p)).toContain('LOCATION_BRIDGE');
  });
  test('unreviewed high-risk prop interaction surfaces its specific mitigation',()=>{
    const p=example();p.takes[0].actions=[{description:'Dog sweeps snow with a broom.',risk:'high',mitigation:'Use stationary muddy pawprints and a reaction instead.'}];
    const e=evidence(p,'plan');e.reviews[0].checks=e.reviews[0].checks.filter(c=>c.category!=='motion');
    expect(check(p,'plan',e).issues.find(i=>i.code==='ACTION_RISK')?.repair).toContain('pawprints');
  });
  test('changed plan or media invalidates saved review evidence',()=>{
    const p=example();const e=evidence(p);p.shots[0].transition.reason='Revised establishing purpose';expect(check(p,'edit',e).status).toBe('needs-review');
    const q=example();const assets=inventory(q);assets.find(a=>a.id==='render')!.sha256='a'.repeat(64);
    const result=lintProduction(q,{stage:'edit',evidence:evidence(q),assets});expect(result.status).toBe('blocked');expect(result.issues.map(i=>i.code)).toContain('REVIEW_MISSING');
  });
  test('a partial or uncertain review never implies a pass',()=>{
    const p=example();const e=evidence(p);e.reviews[0].checks.pop();e.reviews[0].checks[0].verdict='uncertain';e.reviews[0].checks[0].repair='Review the introduction in context.';
    expect(check(p,'edit',e).status).toBe('needs-review');
  });
  test('contradictory review failures are retained despite a pass',()=>{
    const p=example();const e=evidence(p);e.reviews[0].checks.push({category:'speakers',verdict:'fail',evidence:'Another dog speaks the line.',repair:'Regenerate only this performance.'});
    expect(check(p,'edit',e).status).toBe('blocked');
  });
  test('source and rendered durations must match the real files',()=>{
    const p=example();const assets=inventory(p);assets.find(a=>a.id==='bruno-bella-performance')!.durationSeconds=6;assets.find(a=>a.id==='render')!.durationSeconds=10;
    const report=lintProduction(p,{stage:'edit',assets,evidence:evidence(p)});expect(report.issues.map(i=>i.code)).toEqual(expect.arrayContaining(['SOURCE_TOO_SHORT','RENDER_DURATION']));
  });
  test('malformed or incomplete JSON produces a useful blocked report',()=>{
    for(const bad of [null,{}, {...original,shots:[null]}, {...original,version:1}, {...original,shots:[{...original.shots[0],purpose:'bogus'}]}]){
      const report=lintProduction(bad);expect(report.status).toBe('blocked');expect(report.issues[0].code).toBe('INVALID_PLAN');
    }
  });
  test('each take needs its own review at the takes stage',()=>{
    const p=example();const e=evidence(p,'takes');expect(check(p,'takes',e).status).toBe('ready');e.reviews.pop();expect(check(p,'takes',e).status).toBe('needs-review');
  });
  test('hash is independent of object field order but sensitive to story changes',()=>{
    const p=example();const reordered=Object.fromEntries(Object.entries(p).reverse()) as unknown as ProductionPlan;
    expect(productionPlanHash(p)).toBe(productionPlanHash(reordered));p.dialogue[0].text='Changed';expect(productionPlanHash(p)).not.toBe(productionPlanHash(example()));
  });
  test('a media hash alone cannot stand in for duration inspection',()=>{
    const p=example();const assets=inventory(p);delete assets[0].durationSeconds;
    expect(lintProduction(p,{stage:'edit',assets,evidence:evidence(p)}).issues.some(i=>i.code==='METADATA_MISSING')).toBe(true);
  });
  test('passing review with nonexistent shot evidence is rejected',()=>{
    const p=example();const e=evidence(p);e.reviews[0].checks[0].shotId='invented';
    expect(check(p,'edit',e).issues.some(i=>i.code==='INVALID_REVIEW_LOCATION')).toBe(true);
  });
  test('unversioned reference files cannot inherit an earlier plan review',()=>{
    const p=example();delete p.assets.find(a=>a.id==='sadie-rosemary-first')!.sha256;
    expect(check(p,'plan').issues.some(i=>i.code==='ASSET_UNPINNED')).toBe(true);
  });
});
