import { expect, test } from 'bun:test';
import rushed from './fixtures/rushed-ending.plan.json';
import audience from './fixtures/rushed-ending.audience.json';
import { lintProduction, parseProductionPlan, parseProductionEvidence, productionPlanHash, REVIEW_CATEGORIES, STORY_REVIEW_CATEGORIES, type ProductionEvidence } from '../../src/production';

// Curated regression from user-rejected footage. These are test doubles, not a live model evaluation.
function fixture() {
  const plan = parseProductionPlan(structuredClone(rushed));
  const duration = plan.shots.reduce((total, shot) => total + shot.out - shot.in, 0);
  const assets = plan.assets.map(a => ({ id: a.id, sha256: a.sha256, durationSeconds: a.id === 'render' ? duration : plan.takes.find(t => t.assetId === a.id)?.duration }));
  const evidence: ProductionEvidence = parseProductionEvidence({ version: 1, reviews: [{
    version: 1, planHash: productionPlanHash(plan), stage: 'edit', targetId: plan.id,
    assetHash: plan.assets.find(a => a.id === 'render')!.sha256, reviewer: 'TEST DOUBLE',
    checks: REVIEW_CATEGORIES.map(category => ({ category, verdict: 'pass', evidence: 'Test comparison pass, intentionally contradicted by blind audience evidence.' })),
    audience: structuredClone(audience),
  }], speech: plan.takes.flatMap(t => t.dialogue.map(c => ({
    takeId: t.id, assetHash: plan.assets.find(a => a.id === t.assetId)!.sha256,
    lineId: c.lineId, start: c.start, end: c.end, text: plan.dialogue.find(d => d.id === c.lineId)!.text,
    speaker: plan.dialogue.find(d => d.id === c.lineId)!.speaker, confidence: 'confirmed',
  }))) });
  return { plan, assets, evidence };
}

test('the rushed ending can be technically valid while failing all five story checks', () => {
  const { plan, assets, evidence } = fixture();
  const report = lintProduction(plan, { stage: 'edit', assets, evidence });
  expect(report.readiness).toEqual({ technical: 'valid', editorial: 'blocked' });
  expect(report.status).toBe('blocked');
  for (const category of STORY_REVIEW_CATEGORIES) {
    expect(report.issues.some(i => i.code === 'AUDIENCE_FINDING' && i.message.startsWith(category))).toBe(true);
  }
  expect(report.issues.find(i => i.message.startsWith('causality:'))?.repair).toContain('hearing and responding');
});

test('a polished comparison pass cannot erase the audience failure or uncertainty', () => {
  const { plan, assets, evidence } = fixture();
  evidence.reviews.push({ ...evidence.reviews[0], audience: undefined });
  expect(lintProduction(plan, { stage: 'edit', assets, evidence }).status).toBe('blocked');
  evidence.reviews[0].audience!.checks.forEach(c => { c.verdict = 'pass'; });
  expect(lintProduction(plan, { stage: 'edit', assets, evidence }).issues.some(i => i.code === 'AUDIENCE_UNCERTAINTY')).toBe(true);
});

test('legacy edit evidence stays readable but cannot claim story readiness without a blind review', () => {
  const { plan, assets, evidence } = fixture();
  delete evidence.reviews[0].audience;
  const report = lintProduction(plan, { stage: 'edit', assets, evidence });
  expect(report.readiness.technical).toBe('valid');
  expect(report.status).toBe('needs-review');
  expect(report.issues.some(i => i.code === 'AUDIENCE_REVIEW_MISSING')).toBe(true);
});

test('user rejection persists across a plan edit and later automated passes for the same film', () => {
  const { plan, assets, evidence } = fixture();
  evidence.feedback = [{ id: 'user-story-rejection', stage: 'edit', targetId: plan.id, planHash: productionPlanHash(plan), assetHash: evidence.reviews[0].assetHash, reviewer: 'user', verdict: 'fail', evidence: 'The story speeds up to the point where it completely falls apart.', repair: 'Rebuild the final act around motivated scenes.' }];
  plan.title = 'A metadata-only change';
  evidence.reviews[0].planHash = productionPlanHash(plan);
  evidence.reviews[0].audience!.checks.forEach(c => { c.verdict = 'pass'; });
  evidence.reviews[0].audience!.uncertainties = [];
  const report = lintProduction(plan, { stage: 'edit', assets, evidence });
  expect(report.status).toBe('blocked');
  expect(report.issues.some(i => i.code === 'EDITORIAL_FEEDBACK')).toBe(true);
  // A repaired render needs a new review; old rejection is retained but does not reject different bytes.
  plan.assets.find(a => a.id === 'render')!.sha256 = 'a'.repeat(64);
  assets.find(a => a.id === 'render')!.sha256 = 'a'.repeat(64);
  const revised = lintProduction(plan, { stage: 'edit', assets, evidence });
  expect(revised.issues.some(i => i.code === 'EDITORIAL_FEEDBACK')).toBe(false);
  expect(revised.status).toBe('needs-review');
});

test('invented audience timestamps and missing repairs cannot count as story evidence', () => {
  const { plan, assets, evidence } = fixture();
  evidence.reviews[0].audience!.checks[0].at = 500;
  delete evidence.reviews[0].audience!.checks[1].repair;
  const codes = lintProduction(plan, { stage: 'edit', assets, evidence }).issues.map(i => i.code);
  expect(codes).toContain('INVALID_REVIEW_LOCATION');
  expect(codes).toContain('REVIEW_REPAIR_MISSING');
});
