export * from './types.js';
export { parseTimeRef, parseFrames, framesToSeconds, ID_PATTERN, FRAMES_PATTERN, START_ANCHOR, END_ANCHOR, type ParsedTime } from './anchor.js';
export { inSeconds, type InSeconds } from './seconds.js';
export { cutSourceRefs } from './refs.js';
export { ASSET_ID_PATTERN, CUT_NAME_PATTERN, isCutExtension, parseCut, parseCutExtension } from './parse.js';
export { extendCut, loadCutSource, type LoadCutSourceOptions } from './extend.js';
export { mediaRoot, relativeToRoot, resolveCut, type ResolveOptions } from './resolve.js';
export * from './words.js';
export * from './onset.js';
export { lineSound, resolvePerformances, type LineSound, type PerformanceContext } from './performance.js';
export * from './prosody.js';
export * from './check.js';
export * from './listen.js';
export * from './storyboard.js';
export {
  bedPartGainAt,
  fadeAt,
  framesIn,
  gainAt,
  keyValueAt,
  layerGainAt,
  lineGainAt,
  opacityAt,
  overlayShownAt,
  positionAt,
  segmentGainAt,
  waveAt,
  zoomAt,
} from './envelope.js';

export {
  FULL_QUALITY,
  PREVIEW_QUALITY,
  RENDER_SAMPLE_RATE,
  planRender,
  renderArgs,
  type RenderInput,
  type RenderOptions,
  type RenderOutput,
  type RenderPlan,
  type RenderPlanResult,
  type RenderTiming,
} from './render/plan.js';
export { timeOnTimeline } from './render/range.js';

import { parseCut } from './parse.js';
import { resolveCut, type ResolveOptions } from './resolve.js';
import type { CutResult, Timeline } from './types.js';

/** Parses cut-file JSON and resolves it in one step. */
export function resolveCutJson(json: unknown, options?: ResolveOptions): CutResult<Timeline> {
  const parsed = parseCut(json);
  return parsed.ok ? resolveCut(parsed.value, options) : parsed;
}
