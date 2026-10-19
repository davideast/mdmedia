export * from './types.js';
export { parseTimeRef, ID_PATTERN, START_ANCHOR, END_ANCHOR, type ParsedTime } from './anchor.js';
export { parseCut } from './parse.js';
export { resolveCut, type ResolveOptions } from './resolve.js';
export { gainAt, keyValueAt, opacityAt, positionAt } from './envelope.js';

import { parseCut } from './parse.js';
import { resolveCut, type ResolveOptions } from './resolve.js';
import type { CutResult, Timeline } from './types.js';

/** Parses cut-file JSON and resolves it in one step. */
export function resolveCutJson(json: unknown, options?: ResolveOptions): CutResult<Timeline> {
  const parsed = parseCut(json);
  return parsed.ok ? resolveCut(parsed.value, options) : parsed;
}
