export type ProductionStage = 'plan' | 'takes' | 'edit';
export const BASE_REVIEW_CATEGORIES = ['exposition', 'transitions', 'continuity', 'speakers', 'pacing', 'motion', 'sound'] as const;
export const STORY_REVIEW_CATEGORIES = ['audience-understanding', 'causality', 'reactions', 'reveal-setup', 'story-density'] as const;
export const REVIEW_CATEGORIES = [...BASE_REVIEW_CATEGORIES, ...STORY_REVIEW_CATEGORIES] as const;
export type ReviewCategory = typeof REVIEW_CATEGORIES[number];
export type StoryReviewCategory = typeof STORY_REVIEW_CATEGORIES[number];
export const requiredReviewCategories = (stage: ProductionStage): readonly ReviewCategory[] => stage === 'takes' ? BASE_REVIEW_CATEGORIES : REVIEW_CATEGORIES;

export interface ProductionCheck {
  category: ReviewCategory;
  verdict: 'pass' | 'fail' | 'uncertain';
  evidence: string;
  shotId?: string;
  at?: number;
  repair?: string;
}

/** Captured before the reviewer receives any intended story, names or inherited facts. */
export interface AudienceObservation {
  retelling: string;
  understood: { claim: string; at: number }[];
  uncertainties: { question: string; at: number }[];
  checks: (ProductionCheck & { category: StoryReviewCategory; at: number })[];
}

/** A take is generated once. Any number of timeline shots may select ranges of it. */
export interface ProductionPlan {
  version: 2;
  id: string;
  title: string;
  constraints: { forbiddenVisible: string[]; maxWordsPerSecond: number; minTakeSeconds: number; maxTakeSeconds: number };
  assets: { id: string; kind: 'image' | 'video' | 'audio'; path: string; sha256?: string }[];
  characters: { id: string; description: string; voice: string; silent: boolean }[];
  facts: { id: string; description: string }[];
  initialFacts: string[];
  scenes: { id: string; location: string; situation: string; purpose: string; orientationFact: string }[];
  dialogue: { id: string; speaker: string; text: string }[];
  takes: ProductionTake[];
  shots: ProductionShot[];
  renderAssetId?: string;
}

export interface ProductionTake {
  id: string;
  sceneId: string;
  setupId: string;
  method: 'generate' | 'extend' | 'first-frame' | 'reuse';
  duration: number;
  assetId?: string;
  previousTakeId?: string;
  referenceAssetIds: string[];
  firstFrame?: { assetId: string; fromTakeId: string; at: number };
  camera: { size: 'wide' | 'two-shot' | 'medium' | 'close-up' | 'insert'; angle: string; movement: string };
  cast: { characterId: string; position: 'left' | 'center' | 'right'; eyeline: string }[];
  startState: Record<string, string>;
  endState: Record<string, string>;
  stateChanges: { key: string; reason: string }[];
  actions: { description: string; risk: 'low' | 'moderate' | 'high'; mitigation?: string }[];
  dialogue: { lineId: string; start: number; end: number; visibility: 'on-camera' | 'offscreen' }[];
  sound: string;
}

export interface ProductionShot {
  id: string;
  takeId: string;
  in: number;
  out: number;
  purpose: 'establish' | 'question' | 'answer' | 'reaction' | 'escalation' | 'payoff';
  requires: string[];
  establishes: { factId: string; evidence: string; lineId?: string }[];
  transition: {
    type: 'opening' | 'cut' | 'continuous';
    reason: string;
    bridge: 'establishing' | 'same-space' | 'action' | 'gaze' | 'reaction' | 'dialogue' | 'sound' | 'time-passage';
    stateExceptions: { key: string; reason: string }[];
  };
}

export interface ProductionReview {
  version: 1;
  planHash: string;
  stage: ProductionStage;
  targetId: string;
  assetHash?: string;
  reviewer: string;
  checks: ProductionCheck[];
  audience?: AudienceObservation;
  /** Original observation response, retained for audit rather than overwritten by comparison. */
  observations?: string;
}

/** Human feedback is retained independently of automated re-reviews and plan metadata. */
export interface ProductionFeedback {
  id: string;
  stage: ProductionStage;
  targetId: string;
  planHash: string;
  assetHash?: string;
  reviewer: string;
  verdict: 'fail' | 'uncertain';
  evidence: string;
  repair: string;
}

/** Measured speech intervals are independent of the intended timings in a prompt. */
export interface ProductionEvidence {
  version: 1;
  reviews: ProductionReview[];
  feedback?: ProductionFeedback[];
  speech: { takeId: string; assetHash: string; lineId: string; start: number; end: number; text: string; speaker: string; confidence: 'confirmed' | 'estimated' }[];
}

export interface AssetInspection { id: string; sha256?: string; durationSeconds?: number; error?: string }
export interface ProductionIssue {
  code: string;
  severity: 'error' | 'review';
  at: string;
  message: string;
  repair: string;
  domain: 'technical' | 'editorial';
}
export interface ProductionReport {
  version: 1;
  stage: ProductionStage;
  planHash?: string;
  status: 'blocked' | 'needs-review' | 'ready';
  readiness: { technical: 'valid' | 'invalid'; editorial: 'passed' | 'needs-review' | 'blocked' };
  durationSeconds: number;
  issues: ProductionIssue[];
  resolvedIssues?: ProductionIssue[];
}
