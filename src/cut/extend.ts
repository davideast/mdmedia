import { isCutExtension, parseCut, parseCutExtension } from './parse.js';
import type { CutError, CutExtension, CutFile, CutResult, Segment } from './types.js';

/**
 * Cuts that extend other cuts: a variant written as changes to its base.
 * `extendCut` merges one extension onto its base; `loadCutSource` follows a
 * chain of `extends` through a reader it is given. Neither touches the file
 * system, and `resolveCut` only ever sees the merged, full cut.
 */

/**
 * Merges an extension onto its base cut (see `CutExtension`). The result is a
 * full cut, ready for `resolveCut`, which checks its times as usual.
 */
export function extendCut(base: CutFile, extension: CutExtension): CutResult<CutFile> {
  const errors: CutError[] = [];
  const remove = new Set(extension.remove ?? []);
  const lists = [base.segments, base.lines, base.music, base.sfx, base.overlays, base.performances];
  const baseIds = new Set(lists.flatMap((list) => (list ?? []).map((item) => item.id)));
  for (const id of remove) {
    if (!baseIds.has(id)) {
      errors.push({ code: 'unknown-item', id, field: 'remove', message: `remove: the base cut "${extension.extends}" has no item called "${id}"` });
    }
  }
  const notRemoved = (id: string): boolean => {
    if (!remove.has(id)) return true;
    errors.push({ code: 'conflicting-fields', id, field: 'remove', message: `${id}: it is both removed and given again; do one or the other` });
    return false;
  };

  const merge = <T extends { id: string }>(from: T[] | undefined, patch: T[] | undefined): T[] | undefined => {
    if (from === undefined && patch === undefined) return undefined;
    const out = (from ?? []).filter((item) => !remove.has(item.id));
    for (const item of patch ?? []) {
      if (!notRemoved(item.id)) continue;
      const at = out.findIndex((x) => x.id === item.id);
      if (at >= 0) out[at] = item;
      else out.push(item);
    }
    return out;
  };

  const segments: Segment[] = base.segments.filter((s) => !remove.has(s.id));
  for (const { after, ...segment } of extension.segments ?? []) {
    if (!notRemoved(segment.id)) continue;
    const at = segments.findIndex((s) => s.id === segment.id);
    if (after === undefined) {
      if (at >= 0) segments[at] = segment;
      else segments.push(segment);
      continue;
    }
    if (at >= 0) segments.splice(at, 1);
    if (after === '@start') {
      segments.unshift(segment);
      continue;
    }
    const prev = segments.findIndex((s) => s.id === after);
    if (prev < 0) {
      errors.push({ code: 'unknown-item', id: segment.id, field: 'after', message: `${segment.id}.after: no segment is called "${after}"` });
      continue;
    }
    segments.splice(prev + 1, 0, segment);
  }

  if (errors.length > 0) return { ok: false, errors };
  const cut: CutFile = {
    format: base.format,
    meta: { ...base.meta, ...extension.meta },
    media: { ...base.media, ...extension.media },
    segments,
  };
  const output = extension.output ?? base.output;
  if (output !== undefined) cut.output = output;
  const optional = {
    lines: merge(base.lines, extension.lines),
    music: merge(base.music, extension.music),
    sfx: merge(base.sfx, extension.sfx),
    overlays: merge(base.overlays, extension.overlays),
  };
  if (optional.lines) cut.lines = optional.lines;
  if (optional.music) cut.music = optional.music;
  if (optional.sfx) cut.sfx = optional.sfx;
  if (optional.overlays) cut.overlays = optional.overlays;
  const performances = merge(base.performances, extension.performances);
  if (performances) cut.performances = performances;
  if (base.check || extension.check) {
    cut.check = { thresholds: { ...base.check?.thresholds, ...extension.check?.thresholds } };
  }
  const picture = extension.picture ?? base.picture;
  if (picture) cut.picture = picture;
  const mix = extension.mix ?? base.mix;
  if (mix) cut.mix = mix;
  if (base.sources || extension.sources) cut.sources = { ...base.sources, ...extension.sources };
  return { ok: true, value: cut };
}

export interface LoadCutSourceOptions {
  /** The cut's own name, so a loop back to it is caught at once and named. */
  name?: string;
}

/**
 * Parses cut-file JSON, following `extends`: `readBase(name)` returns the
 * parsed JSON of the cut called `name` (for files, `<name>.cut.json` in the
 * same folder). Bases may extend other cuts in turn; a loop is an
 * `extends-cycle` error. A base's errors come back prefixed with its name.
 */
export async function loadCutSource(
  json: unknown,
  readBase: (name: string) => Promise<unknown>,
  options: LoadCutSourceOptions = {},
): Promise<CutResult<CutFile>> {
  return load(json, readBase, options.name === undefined ? [] : [options.name]);
}

async function load(json: unknown, readBase: (name: string) => Promise<unknown>, chain: string[]): Promise<CutResult<CutFile>> {
  if (!isCutExtension(json)) return parseCut(json);
  const parsed = parseCutExtension(json);
  if (!parsed.ok) return parsed;
  const name = parsed.value.extends;
  if (chain.includes(name)) {
    const loop = [...chain.slice(chain.indexOf(name)), name];
    return { ok: false, errors: [{ code: 'extends-cycle', field: 'extends', message: `Cuts extend each other in a loop: ${loop.join(' → ')}` }] };
  }
  let baseJson: unknown;
  try {
    baseJson = await readBase(name);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ code: 'unknown-item', field: 'extends', message: `extends: can't read the base cut "${name}": ${reason}` }] };
  }
  const base = await load(baseJson, readBase, [...chain, name]);
  if (!base.ok) {
    return { ok: false, errors: base.errors.map((e) => (e.code === 'extends-cycle' ? e : { ...e, message: `${name}: ${e.message}` })) };
  }
  return extendCut(base.value, parsed.value);
}
