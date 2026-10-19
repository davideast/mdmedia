export * from './types.js';
export { parseTimeRef, ID_PATTERN, START_ANCHOR, END_ANCHOR, type ParsedTime } from './anchor.js';
export { CUT_NAME_PATTERN, isCutExtension, parseCut, parseCutExtension } from './parse.js';
export { extendCut, loadCutSource, type LoadCutSourceOptions } from './extend.js';
export { mediaRoot, relativeToRoot, resolveCut, type ResolveOptions } from './resolve.js';
export * from './words.js';
export * from './onset.js';
export { gainAt, keyValueAt, opacityAt, positionAt, waveAt, zoomAt } from './envelope.js';

import { parseCut } from './parse.js';
import { resolveCut, type ResolveOptions } from './resolve.js';
import type { CutResult, Timeline } from './types.js';

/** Parses cut-file JSON and resolves it in one step. */
export function resolveCutJson(json: unknown, options?: ResolveOptions): CutResult<Timeline> {
  const parsed = parseCut(json);
  return parsed.ok ? resolveCut(parsed.value, options) : parsed;
}
