import { createHash } from 'node:crypto';
import { parseProductionEvidence, parseProductionPlan } from './schema.js';
import { requiredReviewCategories, STORY_REVIEW_CATEGORIES, type AssetInspection, type ProductionEvidence, type ProductionIssue, type ProductionPlan, type ProductionReport, type ProductionStage } from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function productionPlanHash(plan: ProductionPlan): string {
  return createHash('sha256').update(canonical(plan)).digest('hex');
}
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const epsilon = 0.001;
const overlap = (a: number, b: number, c: number, d: number) => a < d - epsilon && b > c + epsilon;

/** Pure validation. No generation, file access, network, or automatic acceptance of model claims. */
export function lintProduction(input: unknown, options: { stage?: ProductionStage; assets?: AssetInspection[]; evidence?: unknown } = {}): ProductionReport {
  const stage = options.stage ?? 'plan';
  const issues: ProductionIssue[] = [];
  const issue = (code: string, at: string, message: string, repair: string, severity: 'error' | 'review' = 'error', domain: ProductionIssue['domain'] = severity === 'review' ? 'editorial' : 'technical') => issues.push({ code, at, message, repair, severity, domain });
  let plan: ProductionPlan;
  let evidence: ProductionEvidence = { version: 1, reviews: [], speech: [] };
  try { plan = parseProductionPlan(input); }
  catch (error) { return { version: 1, stage, status: 'blocked', readiness: { technical: 'invalid', editorial: 'needs-review' }, durationSeconds: 0, issues: [{ code: 'INVALID_PLAN', domain: 'technical', severity: 'error', at: 'plan', message: String(error), repair: 'Fix the reported version 2 plan fields before checking production.' }] }; }
  if (options.evidence !== undefined) {
    try { evidence = parseProductionEvidence(options.evidence); }
    catch (error) { issue('INVALID_EVIDENCE', 'evidence', String(error), 'Supply valid review and measured speech evidence.'); }
  }
  const hash = productionPlanHash(plan);
  const index = <T extends { id: string }>(items: T[], at: string) => {
    const map = new Map<string, T>();
    for (const item of items) {
      if (map.has(item.id)) issue('DUPLICATE_ID', at, `Duplicate ID ${item.id}.`, 'Give each item a unique stable ID.');
      map.set(item.id, item);
    }
    return map;
  };
  const assets = index(plan.assets, 'assets'), characters = index(plan.characters, 'characters'), facts = index(plan.facts, 'facts');
  for (const a of plan.assets) if (a.sha256 && !/^[a-f0-9]{64}$/.test(a.sha256)) issue('INVALID_HASH', a.id, 'Invalid SHA-256 asset fingerprint.', 'Hash the actual accepted file.');
  const scenes = index(plan.scenes, 'scenes'), lines = index(plan.dialogue, 'dialogue'), takes = index(plan.takes, 'takes');
  const shots = index(plan.shots, 'shots');
  const inspected = new Map(options.assets?.map(a => [a.id, a]));
  for (const review of evidence.reviews.filter(r=>r.planHash===hash)) for (const check of review.checks) {
    if ((check.shotId && !shots.has(check.shotId)) || (check.at !== undefined && check.at < 0)) issue('INVALID_REVIEW_LOCATION', review.targetId, 'Review cites an unknown shot or negative timestamp.', 'Correct the evidence location; do not treat an ungrounded review as a pass.');
    if (check.verdict !== 'pass' && !check.repair) issue('REVIEW_REPAIR_MISSING', review.targetId, check.evidence, 'Record a concrete repair for this failed or uncertain check.');
  }
  const requiredAssets = new Set<string>();
  const asset = (id: string | undefined, at: string, kind?: string, required = true) => {
    const found = id ? assets.get(id) : undefined;
    if (!found || (kind && found.kind !== kind)) issue('ASSET_REFERENCE', at, `Missing ${kind ?? ''} asset ${id ?? '(unassigned)'}.`, 'Resolve the reference to a declared asset of the correct media type.');
    else if (required) requiredAssets.add(found.id);
    return found;
  };
  if (!plan.scenes.length || !plan.takes.length || !plan.shots.length) issue('EMPTY_PRODUCTION', 'plan', 'Production needs scenes, takes and timeline shots.', 'Add the dramatic scene, its source takes and an edit.');
  const limits = plan.constraints;
  if (limits.minTakeSeconds <= 0 || limits.maxTakeSeconds < limits.minTakeSeconds || limits.maxWordsPerSecond <= 0) issue('INVALID_LIMITS', 'constraints', 'Invalid duration or speech-rate limits.', 'Use positive limits from the selected production profile.');
  for (const factId of plan.initialFacts) if (!facts.has(factId)) issue('UNKNOWN_FACT', 'initialFacts', `Unknown fact ${factId}.`, 'Declare the fact or remove the reference.');
  for (const scene of plan.scenes) if (!facts.has(scene.orientationFact)) issue('ORIENTATION_FACT', scene.id, 'Scene has no declared orientation fact.', 'Declare what establishes this location and situation for the viewer.');
  for (const line of plan.dialogue) {
    const actor = characters.get(line.speaker);
    if (!actor || actor.silent) issue('SPEAKER_ROLE', line.id, `Invalid speaking role ${line.speaker}.`, 'Assign the line to its actual speaking character.');
  }
  const earlier = new Set<string>();
  const setups = new Map<string, string>();
  for (const take of plan.takes) {
    const at = take.id;
    if (!scenes.has(take.sceneId)) issue('SCENE_REFERENCE', at, `Unknown scene ${take.sceneId}.`, 'Assign the take to its dramatic scene.');
    if (take.duration <= 0 || (take.method !== 'reuse' && (take.duration < limits.minTakeSeconds || take.duration > limits.maxTakeSeconds))) issue('TAKE_DURATION', at, `Invalid ${take.duration}s source duration for ${take.method}.`, 'Split generation into supported takes; edited shots may be shorter.');
    if (take.method === 'reuse' || stage !== 'plan') asset(take.assetId, at, 'video');
    else if (take.assetId) asset(take.assetId, at, 'video', false);
    const actualDuration = inspected.get(take.assetId ?? '')?.durationSeconds;
    if (actualDuration !== undefined && take.duration > actualDuration + 0.1) issue('SOURCE_TOO_SHORT', at, `Declared take is ${take.duration}s but footage is ${actualDuration.toFixed(3)}s.`, 'Adjust the edit to usable footage or generate the missing duration.');
    take.referenceAssetIds.forEach(id => asset(id, at, 'image'));
    if (take.method === 'generate' && !take.referenceAssetIds.length) issue('UNANCHORED_GENERATION', at, 'New take has no character or set references.', 'Attach approved references for this setup.');
    if (take.method === 'first-frame' && !take.firstFrame) issue('FIRST_FRAME_MISSING', at, 'First-frame generation has no source frame.', 'Extract an exact frame from accepted footage and record its origin.');
    if (take.firstFrame) {
      const parent = takes.get(take.firstFrame.fromTakeId);
      asset(take.firstFrame.assetId, at, 'image');
      if (!parent || !earlier.has(parent.id) || take.firstFrame.at < 0 || take.firstFrame.at >= parent.duration) issue('FRAME_ORIGIN', at, 'Frame must point into an earlier source take.', 'Select a valid frame from accepted predecessor or setup footage.');
      else {
        asset(parent.assetId, at, 'video');
        if (parent.sceneId !== take.sceneId || take.cast.some(actor => !parent.cast.some(p => p.characterId === actor.characterId))) issue('FRAME_CAST_OR_SET', at, 'Starting frame comes from a different scene or lacks the required visible cast.', 'Extract the correct accepted setup frame instead of relying on text to replace its cast or room.');
      }
      if (take.method !== 'first-frame') issue('METHOD_CONFLICT', at, 'A first frame is attached to another generation method.', 'Use first-frame explicitly or remove the conflicting input.');
    }
    if (take.method === 'extend') {
      const parent = takes.get(take.previousTakeId ?? '');
      if (!parent || !earlier.has(parent.id)) issue('CONTINUATION_SOURCE', at, 'Continuation has no earlier source take.', 'Bind the actual predecessor; never fall back to a fresh generation.');
      else {
        if (parent.sceneId !== take.sceneId || parent.setupId !== take.setupId) issue('CONTINUATION_SETUP', at, 'Continuation changes scene or camera setup.', 'Continue the same setup or explicitly plan a referenced cut.');
        for (const [key, value] of Object.entries(parent.endState)) if (take.startState[key] !== value) issue('CONTINUATION_STATE', at, `${key} does not inherit the predecessor ending.`, 'Use the actual preceding end state without resetting action or props.');
        if (stage !== 'plan') asset(parent.assetId, at, 'video');
      }
    } else if (take.previousTakeId) issue('METHOD_CONFLICT', at, 'Only extensions use previousTakeId.', 'Use firstFrame provenance for reseeding; do not label it an extension.');
    const setupKey = `${take.sceneId}/${take.setupId}`;
    const setup = setups.get(setupKey);
    if (setup && take.method === 'generate') issue('UNANCHORED_RETURN', at, `Returning to setup ${take.setupId} with a fresh generation.`, `Reuse ${setup} or start from its accepted footage.`);
    if (setup) {
      const original = takes.get(setup)!;
      if (canonical(original.cast) !== canonical(take.cast) || canonical(original.camera) !== canonical(take.camera)) issue('SETUP_DRIFT', at, 'A returning camera setup changes visible cast, screen positions, eyelines or framing.', 'Match the accepted setup or declare and establish a deliberate new angle.');
    }
    if (!setup) setups.set(setupKey, take.id);
    const visible = new Set<string>();
    for (const actor of take.cast) {
      if (!characters.has(actor.characterId) || visible.has(actor.characterId)) issue('VISIBLE_CAST', at, `Unknown or duplicate visible character ${actor.characterId}.`, 'List exactly the characters visible in this take.');
      visible.add(actor.characterId);
    }
    if (!Object.keys(take.startState).length || !Object.keys(take.endState).length) issue('STATE_MISSING', at, 'Opening and ending physical states must be explicit.', 'Record location, character positions and relevant prop states.');
    for (const key of new Set([...Object.keys(take.startState), ...Object.keys(take.endState)])) {
      if (take.startState[key] !== take.endState[key] && !take.stateChanges.some(c => c.key === key)) issue('UNEXPLAINED_STATE', at, `${key} changes without an action explanation.`, 'Describe the action that causes this state change.');
    }
    for (const action of take.actions) if (action.risk !== 'low') issue('ACTION_RISK', at, action.description, action.mitigation ?? 'Simplify the action or cover it with a safe reaction shot.', 'review');
    const cueIds = new Set<string>();
    for (const cue of take.dialogue) {
      const line = lines.get(cue.lineId);
      if (!line || cueIds.has(cue.lineId)) issue('DIALOGUE_REFERENCE', at, `Unknown or duplicate cue ${cue.lineId}.`, 'Map each performance cue to one declared line.');
      cueIds.add(cue.lineId);
      if (cue.start < 0 || cue.end <= cue.start || cue.end > take.duration) issue('DIALOGUE_TIMING', at, `Cue ${cue.lineId} lies outside the take.`, 'Give the complete spoken line time within the take.');
      if (line && cue.visibility === 'on-camera' && !visible.has(line.speaker)) issue('SPEAKER_ABSENT', at, `${line.speaker} speaks on-camera but is not visible.`, 'Correct visible cast or deliberately designate the line offscreen.');
      if (line && normalize(line.text).split(' ').length / (cue.end - cue.start) > limits.maxWordsPerSecond) issue('SPEECH_PACING', at, `Cue ${cue.lineId} exceeds the planned speaking rate.`, 'Give the line more time or shorten it without losing its story purpose.', 'review');
      if (take.dialogue.some(other => other !== cue && overlap(cue.start, cue.end, other.start, other.end))) issue('SPEAKER_OVERLAP', at, `Cue ${cue.lineId} overlaps another performance cue.`, 'Separate speaking turns and reserve listening beats.');
    }
    earlier.add(at);
  }

  const known = new Set(plan.initialFacts);
  const coverage = new Map<string, number>();
  let duration = 0;
  let prior: typeof plan.shots[number] | undefined;
  for (const [i, shot] of plan.shots.entries()) {
    const take = takes.get(shot.takeId), before = prior && takes.get(prior.takeId);
    const at = shot.id;
    if (!take) { issue('TAKE_REFERENCE', at, `Unknown take ${shot.takeId}.`, 'Select a declared source take.'); continue; }
    if (shot.in < 0 || shot.out <= shot.in || shot.out > take.duration + epsilon) issue('EDIT_RANGE', at, 'Shot range is outside its source footage.', 'Trim within the measured source duration.');
    else duration += shot.out - shot.in;
    if ((i === 0) !== (shot.transition.type === 'opening')) issue('OPENING_TRANSITION', at, 'Only the first shot is an opening.', 'Mark the first image as opening and connect subsequent shots.');
    for (const factId of shot.requires) {
      if (!known.has(factId)) issue('EXPOSITION_MISSING', at, `This beat relies on ${factId} before the audience learns it.`, 'Add an earlier visual or dialogue introduction, or move this beat after its setup.');
    }
    const shotLines = new Set<string>();
    for (const cue of take.dialogue) {
      let start = cue.start, end = cue.end;
      if (stage === 'edit') {
        const observation = evidence.speech.find(s => s.takeId === take.id && s.lineId === cue.lineId && s.assetHash === inspected.get(take.assetId ?? '')?.sha256);
        if (observation) { start = observation.start; end = observation.end; }
      }
      if (!overlap(shot.in, shot.out, start, end)) continue;
      if (shot.in > start + epsilon || shot.out < end - epsilon) issue('CLIPPED_DIALOGUE', at, `Edit cuts through ${cue.lineId}.`, 'Move the cut outside the measured utterance, or split the line into measured phrases.');
      shotLines.add(cue.lineId);
      coverage.set(cue.lineId, (coverage.get(cue.lineId) ?? 0) + 1);
    }
    for (const intro of shot.establishes) {
      if (!facts.has(intro.factId)) issue('UNKNOWN_FACT', at, `Unknown established fact ${intro.factId}.`, 'Declare the audience knowledge this evidence supplies.');
      else if (intro.lineId && !shotLines.has(intro.lineId)) issue('EXPOSITION_EVIDENCE', at, `Introduction cites ${intro.lineId}, which is not in this shot.`, 'Point to dialogue actually included in the edit or use a supported visual introduction.');
      else known.add(intro.factId);
    }
    const scene = scenes.get(take.sceneId);
    if (scene && !known.has(scene.orientationFact)) issue('LOCATION_UNESTABLISHED', at, `The audience has not been oriented to ${scene.location}.`, 'Establish the place and situation before relying on them.');
    if (before && prior) {
      const tr = shot.transition;
      if (before.sceneId !== take.sceneId && !['establishing', 'time-passage', 'sound', 'dialogue'].includes(tr.bridge)) issue('LOCATION_BRIDGE', at, 'A new scene uses a same-scene transition.', 'Provide an arrival, establishing view or explicit sound/dialogue bridge.');
      if (tr.type === 'continuous') {
        const contiguousSource = prior.takeId === shot.takeId && Math.abs(prior.out - shot.in) < epsilon;
        const extension = take.method === 'extend' && take.previousTakeId === before.id && Math.abs(prior.out - before.duration) < epsilon && shot.in === 0;
        const frameMatch = take.method === 'first-frame' && take.firstFrame?.fromTakeId === before.id && Math.abs(take.firstFrame.at - prior.out) <= 1 / 24 + epsilon && shot.in === 0;
        if (!contiguousSource && !extension && !frameMatch) issue('FALSE_CONTINUATION', at, 'Continuous edit is not attached to the preceding visible ending.', 'Use contiguous footage, its extension, or its exact final frame; otherwise mark a motivated cut.');
      }
      if (before.sceneId === take.sceneId && before.id !== take.id) {
        for (const [key, value] of Object.entries(before.endState)) {
          if (key in take.startState && take.startState[key] !== value && !tr.stateExceptions.some(e => e.key === key)) issue('CUT_STATE_JUMP', at, `${key} changes across the cut.`, 'Match the accepted state or explicitly show/explain the change.');
        }
      }
    }
    prior = shot;
  }
  for (const line of plan.dialogue) {
    const count = coverage.get(line.id) ?? 0;
    if (count !== 1) issue(count ? 'REPEATED_DIALOGUE' : 'MISSING_DIALOGUE', line.id, `Line appears ${count} times in the edit.`, 'Include each scripted utterance once, without replaying earlier speech.');
  }
  if (stage === 'edit') asset(plan.renderAssetId, 'render', 'video');
  if (stage === 'edit') {
    const actual = inspected.get(plan.renderAssetId ?? '')?.durationSeconds;
    if (actual !== undefined && Math.abs(actual - duration) > 0.1) issue('RENDER_DURATION', 'render', `Rendered duration ${actual.toFixed(3)}s differs from the ${duration.toFixed(3)}s edit.`, 'Render the current edit and review that output.');
  }
  for (const id of requiredAssets) {
    const info = inspected.get(id), declared = assets.get(id);
    if (!declared?.sha256) issue('ASSET_UNPINNED', id, 'Required source is not pinned to accepted bytes.', 'Record its SHA-256 in the plan so changed references invalidate previous reviews.');
    if (!info?.sha256 || info.error) issue('ASSET_UNVERIFIED', id, info?.error ?? 'File has not been inspected.', 'Resolve and hash the actual local file before proceeding.');
    else if (declared?.sha256 && declared.sha256 !== info.sha256) issue('ASSET_CHANGED', id, 'File differs from the pinned accepted asset.', 'Restore the accepted asset or explicitly revise its provenance and re-review.');
    if (declared?.kind === 'video' && (!info?.durationSeconds || !Number.isFinite(info.durationSeconds))) issue('METADATA_MISSING', id, 'Source duration has not been measured.', 'Inspect the actual MP4/MOV metadata rather than trusting prompt duration.');
  }
  if (stage === 'edit') for (const take of plan.takes.filter(t => plan.shots.some(s => s.takeId === t.id))) {
    for (const cue of take.dialogue) {
      const observations = evidence.speech.filter(s => s.takeId === take.id && s.lineId === cue.lineId);
      const observed = observations[0], expected = lines.get(cue.lineId);
      if (observations.length !== 1 || !observed || observed.assetHash !== inspected.get(take.assetId ?? '')?.sha256) {
        issue('SPEECH_UNVERIFIED', take.id, `No unique current-source timing evidence for ${cue.lineId}.`, 'Transcribe and time the actual source utterance; bind the evidence to its file hash.', 'review');
        continue;
      }
      if (observed.start < 0 || observed.end <= observed.start || observed.end > take.duration) issue('SPEECH_RANGE', take.id, `Invalid measured interval for ${cue.lineId}.`, 'Correct speech boundaries using the source audio.');
      if (expected && (observed.speaker !== expected.speaker || normalize(observed.text) !== normalize(expected.text))) issue('SPEECH_MISMATCH', take.id, `Actual speaker or words differ for ${cue.lineId}.`, 'Repair the performance or explicitly revise the script before accepting it.');
      if (observed.confidence !== 'confirmed') issue('SPEECH_ESTIMATED', take.id, `Timing for ${cue.lineId} is estimated.`, 'Confirm source speech boundaries before treating dialogue cuts as verified.', 'review');
    }
  }
  // Coverage is explicit. An empty/partial review or an old pass never implies acceptance.
  const targets = stage === 'plan' ? [{ id: plan.id, assetId: undefined }] : stage === 'takes' ? plan.takes.map(t => ({ id: t.id, assetId: t.assetId })) : [{ id: plan.id, assetId: plan.renderAssetId }];
  const resolvedIssues: ProductionIssue[] = [];
  for (const target of targets) {
    const matching = evidence.reviews.filter(r => r.stage === stage && r.targetId === target.id && r.planHash === hash && (stage === 'plan' || r.assetHash === inspected.get(target.assetId ?? '')?.sha256));
    for (const category of requiredReviewCategories(stage)) {
      const checks = matching.flatMap(r => r.checks.filter(c => c.category === category));
      if (!checks.length) issue('REVIEW_MISSING', target.id, `No current ${category} review for ${stage}.`, 'Review this plan or media and record evidence tied to the current plan and file hashes.', 'review');
      for (const check of checks) if (check.verdict !== 'pass') issue('REVIEW_FINDING', check.shotId ?? target.id, `${category}: ${check.evidence}`, check.repair ?? 'Inspect the cited evidence and resolve this finding.', check.verdict === 'fail' ? 'error' : 'review', 'editorial');
      // Editorial evidence can resolve heuristics, never structural errors or missing measurements.
      if (checks.length && checks.every(c => c.verdict === 'pass')) {
        for (let i = issues.length - 1; i >= 0; i--) {
          const item = issues[i];
          if ((stage !== 'takes' || item.at === target.id) && ((category === 'pacing' && item.code === 'SPEECH_PACING') || (category === 'motion' && item.code === 'ACTION_RISK'))) resolvedIssues.push(...issues.splice(i, 1));
        }
      }
    }
  }
  if (stage === 'edit') {
    const renderHash = inspected.get(plan.renderAssetId ?? '')?.sha256;
    // A blind audience saw these bytes, independent of later synopsis/metadata changes.
    const audiences = renderHash ? evidence.reviews.filter(r => r.stage === 'edit' && r.assetHash === renderHash && r.audience).map(r => r.audience!) : [];
    if (!audiences.length) issue('AUDIENCE_REVIEW_MISSING', plan.id, 'No saved blind audience review of this edit.', 'Review the video or rough sequence without its script, synopsis or inherited facts; retain the retelling and all five story checks.', 'review');
    const validLocation = (at: number, shotId?: string) => at >= 0 && at < duration && (!shotId || shots.has(shotId));
    for (const audience of audiences) {
      for (const category of STORY_REVIEW_CATEGORIES) {
        if (!audience.checks.some(c => c.category === category)) issue('AUDIENCE_CHECK_MISSING', plan.id, `No blind ${category} check.`, 'Complete all five audience checks without supplying the intended answers.', 'review');
      }
      for (const check of audience.checks) {
        if (!validLocation(check.at, check.shotId)) issue('INVALID_REVIEW_LOCATION', plan.id, 'Audience evidence cites an unknown shot or a timestamp outside this edit.', 'Cite an observable moment within this rendered sequence.');
        if (check.verdict !== 'pass') {
          if (!check.repair) issue('REVIEW_REPAIR_MISSING', plan.id, check.evidence, 'Give this audience finding a specific repair.');
          issue('AUDIENCE_FINDING', check.shotId ?? `${plan.id}@${check.at}s`, `${check.category}: ${check.evidence}`, check.repair ?? 'Inspect and repair the cited story gap.', check.verdict === 'fail' ? 'error' : 'review', 'editorial');
        }
      }
      for (const observation of [...audience.understood, ...audience.uncertainties]) {
        if (!validLocation(observation.at)) issue('INVALID_REVIEW_LOCATION', plan.id, 'Audience observation is outside the rendered sequence.', 'Correct its timestamp using the actual video.');
      }
      for (const uncertainty of audience.uncertainties) issue('AUDIENCE_UNCERTAINTY', `${plan.id}@${uncertainty.at}s`, uncertainty.question, 'Determine whether this is a deliberate story question or a missing explanation; repair and review the revised sequence.', 'review');
    }
  }
  for (const feedback of evidence.feedback ?? []) {
    if (feedback.stage !== 'plan' && !/^[a-f0-9]{64}$/.test(feedback.assetHash ?? '')) {
      issue('FEEDBACK_ASSET_MISSING', feedback.id, 'Footage feedback must identify the reviewed bytes.', 'Bind this feedback to the actual take or render hash.');
      continue;
    }
    const applies = feedback.stage === stage && (stage === 'plan'
      ? feedback.planHash === hash && feedback.targetId === plan.id
      : targets.some(target => !!feedback.assetHash && feedback.assetHash === inspected.get(target.assetId ?? '')?.sha256));
    if (applies) issue('EDITORIAL_FEEDBACK', feedback.id, `${feedback.reviewer}: ${feedback.evidence}`, feedback.repair, feedback.verdict === 'fail' ? 'error' : 'review', 'editorial');
  }
  const technical = issues.some(i => i.domain === 'technical' && i.severity === 'error') ? 'invalid' : 'valid';
  const editorial = issues.some(i => i.domain === 'editorial' && i.severity === 'error') ? 'blocked' : issues.some(i => i.domain === 'editorial') ? 'needs-review' : 'passed';
  return { version: 1, stage, planHash: hash, durationSeconds: duration, status: issues.some(i => i.severity === 'error') ? 'blocked' : issues.length ? 'needs-review' : 'ready', readiness: { technical, editorial }, issues, resolvedIssues };
}
