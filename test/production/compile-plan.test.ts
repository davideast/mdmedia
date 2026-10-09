import { describe, expect, test } from 'bun:test';
import { compilePlan, validatePlan, type ProductionPlan } from '../../scripts/compile-production-plan';
import original from '../../drafts/beneath-double-coat/breakfast-production-plan.json';
const plan = () => structuredClone(original) as ProductionPlan;

describe('breakfast production compilation', () => {
  test('keeps actual continuation dependencies and 90-second timeline', () => {
    const result = compilePlan(plan());
    expect(result.durationSeconds).toBe(90);
    expect(result.requests).toHaveLength(12);
    expect(result.requests.filter(r=>r.operation==='extend').map(r=>[r.shotId,r.previousInteractionFrom])).toEqual([
      ['s02','s01'],['s03','s02'],['s06','s05'],['s07','s06'],['s10','s09'],['s12','s11']
    ]);
    expect(result.requests[3].previousInteractionFrom).toBeNull();
    expect(result.requests[3].referenceFrames[0].shotId).toBe('s03');
  });
  test('compiles offscreen Heidi without making addressed Otto the speaker', () => {
    const request = compilePlan(plan()).requests[1];
    expect(request.prompt).toContain('1–3s: HEIDI ONLY (offscreen)');
    expect(request.prompt).toContain('Otto! Breakfast.');
    expect(request.prompt).not.toContain('OTTO ONLY');
    expect(request.prompt).not.toContain('We’ve discussed this.');
  });
  test('compiles one cross-cut recording, with nonduplicated source offsets', () => {
    const result = compilePlan(plan());
    expect(result.audioBridges).toHaveLength(1);
    const bridge = result.audioBridges[0];
    expect(bridge.text).toBe('We can investigate your marriage after breakfast.');
    expect(bridge.renderCount).toBe(1);
    expect(bridge.placements.map(p=>[p.shotId,p.localStart,p.localEnd,p.sourceIn])).toEqual([
      ['s10',8.5,9,0],['s11',0,4,0.5]
    ]);
    for (const index of [9,10]) expect(result.requests[index].prompt).not.toContain(bridge.text);
    expect(result.requests[10].prompt).toContain('GENERATED DIALOGUE: None');
  });
  test('rejects speaker-role, timeline, and dependency errors', () => {
    const wrongSpeaker=plan();wrongSpeaker.dialogue[0].speaker='OTTO';
    expect(()=>validatePlan(wrongSpeaker)).toThrow('Invalid speaking role');
    const absent=plan();delete absent.shots[3].visibleCharacters.HEIDI;
    expect(()=>validatePlan(absent)).toThrow('Speaker absent');
    const broken=plan();broken.shots[2].previousShotId='s01';
    expect(()=>validatePlan(broken)).toThrow('Broken predecessor');
    const gap=plan();gap.shots[1].start=9;
    expect(()=>validatePlan(gap)).toThrow('Invalid timing');
    const duplicate=plan();duplicate.dialogue[9].production='native';
    expect(()=>validatePlan(duplicate)).toThrow('Cross-cut speech');
  });
});
