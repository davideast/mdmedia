import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import original from './fixtures/breakfast.plan.json';
import { audiencePass, movieHeader } from './helpers';
import {
  appendProductionReview, parseProductionPlan, productionPlanHash, reviewProduction, hashProductionFile,
  REVIEW_CATEGORIES, BASE_REVIEW_CATEGORIES, STORY_REVIEW_CATEGORIES,
  type ProductionReviewRequest, type ProductionPlan, type ProductionEvidence,
} from '../../src/production';

const passes = () => ({ checks: REVIEW_CATEGORIES.map(category => ({ category, verdict: 'pass', evidence: 'Test-only reviewer observation.' })) });
async function withVideo(run: (plan: ProductionPlan, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'production-review-'));
  try {
    const plan = parseProductionPlan(structuredClone(original));
    const render = plan.assets.find(a => a.id === plan.renderAssetId)!;
    render.path = join(dir, 'test.mp4');
    await writeFile(render.path, movieHeader(28.25));
    render.sha256 = await hashProductionFile(render.path);
    await run(plan, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('evidence-based production reviewer', () => {
  test('plan preflight includes story checks without private file paths or hashes', async () => {
    const plan = parseProductionPlan(structuredClone(original));
    const requests: ProductionReviewRequest[] = [];
    const result = await reviewProduction(plan, { stage: 'plan', root: '.', reviewer: 'test', review: async request => { requests.push(request); return JSON.stringify(passes()); } });
    expect(requests).toHaveLength(1); expect(requests[0].media).toBeUndefined();
    expect(requests[0].prompt).not.toContain('.design/');
    expect(requests[0].prompt).not.toContain(plan.assets[0].sha256!);
    for (const category of STORY_REVIEW_CATEGORIES) expect(requests[0].prompt).toContain(category);
    expect(result.planHash).toBe(productionPlanHash(plan)); expect(result.targetId).toBe(plan.id);
    expect(result.audience).toBeUndefined();
  });

  test('blind viewer evidence is retained even when the plan comparison passes', async () => withVideo(async (plan, dir) => {
    const audience = audiencePass();
    audience.checks[0] = { category: 'audience-understanding', verdict: 'fail', at: 2, evidence: 'The relationship is unexplained.', repair: 'Establish the relationship before the accusation.' };
    const observation = { transcript: ['Independent observation'], audience };
    const requests: ProductionReviewRequest[] = [];
    const result = await reviewProduction(plan, { stage: 'edit', root: dir, reviewer: 'test', review: async request => {
      requests.push(request); return JSON.stringify(requests.length === 1 ? observation : passes());
    } });
    expect(requests).toHaveLength(2); expect(requests[0].media).toBeDefined();
    for (const spoiler of ['Parmesan', plan.title, plan.id, ...plan.characters.map(c => c.id)]) expect(requests[0].prompt).not.toContain(spoiler);
    expect(requests[0].prompt).not.toContain('initialFacts');
    expect(requests[1].prompt).toContain('Independent observation'); expect(requests[1].prompt).toContain('Parmesan');
    expect(requests[1].prompt).not.toContain(dir);
    expect(result.assetHash).toBe(plan.assets.find(a => a.id === plan.renderAssetId)!.sha256);
    expect(result.audience).toEqual(audience);
    expect(result.observations).toBe(JSON.stringify(observation));
    expect(result.checks.every(c => c.verdict === 'pass')).toBe(true);
  }));

  test('invalid audience evidence stops before the comparison can supply missing answers', async () => withVideo(async (plan, dir) => {
    const missingCategory = audiencePass(); missingCategory.checks.pop();
    const missingRepair = audiencePass(); missingRepair.checks[0].verdict = 'uncertain';
    const outsideVideo = audiencePass(); outsideVideo.understood[0].at = 50;
    const negativeTime = audiencePass(); negativeTime.checks[0].at = -1;
    for (const audience of [undefined, missingCategory, missingRepair, outsideVideo, negativeTime]) {
      let calls = 0;
      await expect(reviewProduction(plan, { stage: 'edit', root: dir, reviewer: 'test', review: async () => {
        calls++; return JSON.stringify({ audience });
      } })).rejects.toThrow();
      expect(calls).toBe(1);
    }
  }));

  test('isolated takes do not require a blind whole-story assessment', async () => withVideo(async (plan, dir) => {
    plan.takes[0].assetId = plan.renderAssetId;
    const requests: ProductionReviewRequest[] = [];
    const result = await reviewProduction(plan, { stage: 'takes', targetId: plan.takes[0].id, root: dir, reviewer: 'test', review: async request => {
      requests.push(request);
      return JSON.stringify(requests.length === 1 ? { transcript: ['An isolated performance.'] } : { checks: passes().checks.filter(c => (BASE_REVIEW_CATEGORIES as readonly string[]).includes(c.category)) });
    } });
    expect(result.audience).toBeUndefined();
    expect(result.checks).toHaveLength(7);
    expect(requests[0].prompt).toContain('intentional editing handles');
    expect(requests[0].prompt).not.toContain('story-density');
  }));

  test('appending a review preserves old findings, speech evidence and user rejection', async () => withVideo(async (plan, dir) => {
    const review = await reviewProduction(plan, { stage: 'edit', root: dir, reviewer: 'test', review: async request => JSON.stringify(request.prompt.startsWith('Watch') ? { audience: audiencePass() } : passes()) });
    const earlier = structuredClone(review);
    earlier.audience!.checks[0] = { category: 'audience-understanding', verdict: 'fail', at: 2, evidence: 'Confusing.', repair: 'Establish the stakes.' };
    const evidence: ProductionEvidence = { version: 1, reviews: [earlier], speech: [], feedback: [{ id: 'user-rejection', stage: 'edit', targetId: plan.id, planHash: review.planHash, assetHash: review.assetHash, reviewer: 'user', verdict: 'fail', evidence: 'Rushed.', repair: 'Rebuild the ending.' }] };
    const appended = appendProductionReview(evidence, review);
    expect(appended.reviews).toEqual([earlier, review]);
    expect(appended.feedback).toEqual(evidence.feedback);
    expect(appended.speech).toEqual(evidence.speech);
    expect(evidence.reviews).toHaveLength(1);
  }));

  test('bad provider output cannot become an accepted review', async () => {
    for (const response of ['{}', '{"checks": [{"category":"speakers","verdict":"good"}]}', 'not JSON']) {
      await expect(reviewProduction(parseProductionPlan(original), { stage: 'plan', root: '.', reviewer: 'test', review: async () => response })).rejects.toThrow();
    }
  });
  test('review requires a specific existing take target', async () => {
    await expect(reviewProduction(parseProductionPlan(original), { stage: 'takes', root: '.', targetId: 'unknown', reviewer: 'test', review: async () => JSON.stringify(passes()) })).rejects.toThrow('targetId');
  });
});
