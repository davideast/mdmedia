import { REVIEW_CATEGORIES, STORY_REVIEW_CATEGORIES, type AudienceObservation, type ProductionEvidence, type ProductionPlan } from './types.js';

// Small internal JSON shape validator. No coercion: malformed agent output is a reportable error.
type Shape = 'text' | 'number' | 'boolean' | { literal: string | number } | { enum: readonly string[] } | { array: Shape } | { record: Shape } | { optional: Shape } | { fields: Record<string, Shape> };
const array = (shape: Shape): Shape => ({ array: shape });
const object = (fields: Record<string, Shape>): Shape => ({ fields });
const optional = (shape: Shape): Shape => ({ optional: shape });
const choice = (...values: string[]): Shape => ({ enum: values });
const texts = array('text');
const changes = array(object({ key: 'text', reason: 'text' }));
const stage = choice('plan', 'takes', 'edit');
const checkFields = {
  category: choice(...REVIEW_CATEGORIES), verdict: choice('pass', 'fail', 'uncertain'),
  evidence: 'text' as const, shotId: optional('text'), at: optional('number'), repair: optional('text'),
};
const audienceShape = object({
  retelling: 'text',
  understood: array(object({ claim: 'text', at: 'number' })),
  uncertainties: array(object({ question: 'text', at: 'number' })),
  checks: array(object({ ...checkFields, category: choice(...STORY_REVIEW_CATEGORIES), at: 'number' })),
});
const planShape = object({
  version: { literal: 2 }, id: 'text', title: 'text',
  constraints: object({ forbiddenVisible: texts, maxWordsPerSecond: 'number', minTakeSeconds: 'number', maxTakeSeconds: 'number' }),
  assets: array(object({ id: 'text', kind: choice('image', 'video', 'audio'), path: 'text', sha256: optional('text') })),
  characters: array(object({ id: 'text', description: 'text', voice: 'text', silent: 'boolean' })),
  facts: array(object({ id: 'text', description: 'text' })), initialFacts: texts,
  scenes: array(object({ id: 'text', location: 'text', situation: 'text', purpose: 'text', orientationFact: 'text' })),
  dialogue: array(object({ id: 'text', speaker: 'text', text: 'text' })),
  takes: array(object({
    id: 'text', sceneId: 'text', setupId: 'text', method: choice('generate', 'extend', 'first-frame', 'reuse'), duration: 'number',
    assetId: optional('text'), previousTakeId: optional('text'), referenceAssetIds: texts,
    firstFrame: optional(object({ assetId: 'text', fromTakeId: 'text', at: 'number' })),
    camera: object({ size: choice('wide', 'two-shot', 'medium', 'close-up', 'insert'), angle: 'text', movement: 'text' }),
    cast: array(object({ characterId: 'text', position: choice('left', 'center', 'right'), eyeline: 'text' })),
    startState: { record: 'text' }, endState: { record: 'text' }, stateChanges: changes,
    actions: array(object({ description: 'text', risk: choice('low', 'moderate', 'high'), mitigation: optional('text') })),
    dialogue: array(object({ lineId: 'text', start: 'number', end: 'number', visibility: choice('on-camera', 'offscreen') })),
    sound: 'text',
  })),
  shots: array(object({
    id: 'text', takeId: 'text', in: 'number', out: 'number', purpose: choice('establish', 'question', 'answer', 'reaction', 'escalation', 'payoff'),
    requires: texts, establishes: array(object({ factId: 'text', evidence: 'text', lineId: optional('text') })),
    transition: object({ type: choice('opening', 'cut', 'continuous'), reason: 'text', bridge: choice('establishing', 'same-space', 'action', 'gaze', 'reaction', 'dialogue', 'sound', 'time-passage'), stateExceptions: changes }),
  })), renderAssetId: optional('text'),
});
const evidenceShape = object({
  version: { literal: 1 },
  reviews: array(object({
    version: { literal: 1 }, planHash: 'text', stage, targetId: 'text', assetHash: optional('text'), reviewer: 'text',
    checks: array(object(checkFields)), audience: optional(audienceShape), observations: optional('text'),
  })),
  feedback: optional(array(object({
    id: 'text', stage, targetId: 'text', planHash: 'text', assetHash: optional('text'), reviewer: 'text',
    verdict: choice('fail', 'uncertain'), evidence: 'text', repair: 'text',
  }))),
  speech: array(object({ takeId: 'text', assetHash: 'text', lineId: 'text', start: 'number', end: 'number', text: 'text', speaker: 'text', confidence: choice('confirmed', 'estimated') })),
});

function validate(value: unknown, shape: Shape, path: string, errors: string[]): void {
  if (typeof shape === 'string') {
    const valid = shape === 'text' ? typeof value === 'string' && !!value.trim() : shape === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === 'boolean';
    if (!valid) errors.push(`${path}: expected ${shape}`);
  } else if ('optional' in shape) {
    if (value !== undefined) validate(value, shape.optional, path, errors);
  } else if ('literal' in shape) {
    if (value !== shape.literal) errors.push(`${path}: expected ${shape.literal}`);
  } else if ('enum' in shape) {
    if (typeof value !== 'string' || !shape.enum.includes(value)) errors.push(`${path}: expected ${shape.enum.join(' | ')}`);
  } else if ('array' in shape) {
    if (!Array.isArray(value)) errors.push(`${path}: expected array`);
    else value.forEach((entry, i) => validate(entry, shape.array, `${path}[${i}]`, errors));
  } else if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(`${path}: expected object`);
  else {
    const record = value as Record<string, unknown>;
    if ('record' in shape) for (const [key, entry] of Object.entries(record)) validate(entry, shape.record, `${path}.${key}`, errors);
    else {
      for (const [key, field] of Object.entries(shape.fields)) validate(record[key], field, `${path}.${key}`, errors);
      for (const key of Object.keys(record)) if (!Object.hasOwn(shape.fields, key)) errors.push(`${path}.${key}: unknown field`);
    }
  }
}

export function parseProductionPlan(value: unknown): ProductionPlan {
  const errors: string[] = [];
  validate(value, planShape, 'plan', errors);
  if (errors.length) throw new Error(errors.join('\n'));
  return value as ProductionPlan;
}
export function parseProductionEvidence(value: unknown): ProductionEvidence {
  const errors: string[] = [];
  validate(value, evidenceShape, 'evidence', errors);
  if (errors.length) throw new Error(errors.join('\n'));
  return value as ProductionEvidence;
}

export function parseAudienceObservation(value: unknown): AudienceObservation {
  const errors: string[] = [];
  validate(value, audienceShape, 'audience', errors);
  if (errors.length) throw new Error(errors.join('\n'));
  const observation = value as AudienceObservation;
  for (const category of STORY_REVIEW_CATEGORIES) {
    if (!observation.checks.some(check => check.category === category)) errors.push(`audience: missing ${category} check`);
  }
  for (const check of observation.checks) {
    if (check.verdict !== 'pass' && !check.repair) errors.push(`audience: ${check.category} needs a concrete repair`);
  }
  for (const item of [...observation.checks, ...observation.understood, ...observation.uncertainties]) {
    if (item.at < 0) errors.push('audience: negative timestamp');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return observation;
}
