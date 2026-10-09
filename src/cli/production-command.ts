import { defineCommand } from 'citty';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendProductionReview, geminiProductionReviewer, inspectProductionAssets, lintProduction, parseProductionEvidence, parseProductionPlan, productionPlanHash, reviewProduction, type ProductionEvidence, type ProductionReport, type ProductionStage } from '../production/index.js';

const common = {
  input: { type: 'string' as const, required: true as const, description: 'Version 2 production plan JSON' },
  root: { type: 'string' as const, description: 'Asset path root (defaults to the plan directory)' },
  stage: { type: 'string' as const, default: 'plan', description: 'plan, takes, or edit' },
  evidence: { type: 'string' as const, description: 'Saved review and source speech evidence JSON' },
};
function stageValue(value: string): ProductionStage {
  if (value !== 'plan' && value !== 'takes' && value !== 'edit') throw new Error('Stage must be plan, takes, or edit.');
  return value;
}
export function formatProductionReport(report: ProductionReport): string {
  return [
    `${report.status === 'ready' && report.stage === 'edit' ? 'READY FOR USER REVIEW' : report.status.toUpperCase()} · ${report.stage} · ${report.durationSeconds.toFixed(2)}s`,
    `Technical: ${report.readiness.technical} · Editorial: ${report.readiness.editorial}`,
    ...report.issues.map(i => `${i.severity.toUpperCase()} ${i.code} [${i.at}] ${i.message}\n  Repair: ${i.repair}`),
  ].join('\n');
}
async function load(args: { input: string; root?: string; evidence?: string; stage: string }) {
  const plan = parseProductionPlan(JSON.parse(await readFile(args.input, 'utf8')));
  const evidence: ProductionEvidence = args.evidence ? parseProductionEvidence(JSON.parse(await readFile(args.evidence, 'utf8'))) : { version: 1, reviews: [], speech: [] };
  return { plan, evidence, root: resolve(args.root ?? dirname(args.input)), stage: stageValue(args.stage) };
}
export const productionCommand = defineCommand({
  meta: { name: 'production', description: 'Lint storytelling, continuity and edits; review plans or rendered footage' },
  subCommands: {
    lint: defineCommand({
      args: { ...common, json: { type: 'boolean', default: false, description: 'Print structured findings' }, output: { type: 'string', description: 'Also save report JSON' } },
      async run({ args }) {
        const stage = stageValue(args.stage);
        let report: ProductionReport;
        try {
          const { plan, evidence, root } = await load(args);
          report = lintProduction(plan, { stage, evidence, assets: await inspectProductionAssets(plan, root) });
        } catch (error) {
          report = { version: 1, stage, status: 'blocked', readiness: { technical: 'invalid', editorial: 'needs-review' }, durationSeconds: 0, issues: [{ code: 'INVALID_INPUT', domain: 'technical', severity: 'error', at: args.input, message: error instanceof Error ? error.message : String(error), repair: 'Correct the input or evidence JSON and referenced file paths.' }] };
        }
        if (args.output) await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
        console.log(args.json ? JSON.stringify(report, null, 2) : formatProductionReport(report));
        process.exitCode = report.status === 'blocked' ? 1 : report.status === 'needs-review' ? 2 : 0;
      },
    }),
    review: defineCommand({
      args: { ...common, output: { type: 'string', required: true, description: 'Save merged evidence JSON' }, take: { type: 'string', description: 'Take ID when stage=takes' }, model: { type: 'string', default: 'gemini-3.1-pro-preview', description: 'Gemini review model; this command sends plan/media to the provider' } },
      async run({ args }) {
        const { plan, evidence, root, stage } = await load(args);
        const assets = await inspectProductionAssets(plan, root);
        const structural = lintProduction(plan, { stage: 'plan', assets, evidence });
        if (structural.readiness.technical === 'invalid') throw new Error(`Repair structural errors before provider review:\n${formatProductionReport(structural)}`);
        const review = await reviewProduction(plan, { stage, root, targetId: args.take, reviewer: args.model, review: geminiProductionReviewer(args.model) });
        await writeFile(args.output, JSON.stringify(appendProductionReview(evidence, review), null, 2) + '\n');
        console.log(`Saved ${stage} review for ${review.targetId} to ${args.output}. Run production lint to evaluate readiness.`);
      },
    }),
    feedback: defineCommand({
      meta: { description: 'Save editorial rejection or uncertainty locally; automated review cannot erase it' },
      args: {
        ...common,
        output: { type: 'string', required: true, description: 'Save merged evidence JSON' },
        take: { type: 'string', description: 'Take ID when stage=takes' },
        message: { type: 'string', required: true, description: 'Actual editorial feedback' },
        repair: { type: 'string', required: true, description: 'Concrete next revision' },
        verdict: { type: 'string', default: 'fail', description: 'fail or uncertain' },
        reviewer: { type: 'string', default: 'user', description: 'Who supplied the feedback' },
      },
      async run({ args }) {
        if (args.verdict !== 'fail' && args.verdict !== 'uncertain') throw new Error('Feedback verdict must be fail or uncertain.');
        const { plan, evidence, root, stage } = await load(args);
        const take = stage === 'takes' ? plan.takes.find(t => t.id === args.take) : undefined;
        if (stage === 'takes' && !take) throw new Error('Take feedback requires a valid --take.');
        let assetHash: string | undefined;
        if (stage !== 'plan') {
          const asset = plan.assets.find(a => a.id === (stage === 'edit' ? plan.renderAssetId : take?.assetId));
          if (!asset || asset.kind !== 'video') throw new Error('Feedback target has no video asset.');
          const [inspection] = await inspectProductionAssets({ ...plan, assets: [asset] }, root);
          if (inspection.error || !inspection.sha256 || !inspection.durationSeconds) throw new Error(inspection.error ?? 'Cannot inspect feedback video.');
          if (asset.sha256 && inspection.sha256 !== asset.sha256) throw new Error('Feedback video differs from its pinned hash.');
          assetHash = inspection.sha256;
        }
        evidence.feedback = [...evidence.feedback ?? [], {
          id: randomUUID(), stage, targetId: take?.id ?? plan.id, planHash: productionPlanHash(plan),
          ...(assetHash ? { assetHash } : {}), reviewer: args.reviewer, verdict: args.verdict,
          evidence: args.message, repair: args.repair,
        }];
        await writeFile(args.output, JSON.stringify(parseProductionEvidence(evidence), null, 2) + '\n');
        console.log(`Saved ${args.verdict} feedback for ${take?.id ?? plan.id}. Prior reviews and feedback retained.`);
      },
    }),
  },
});
