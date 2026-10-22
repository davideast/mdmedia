import { isMap, isScalar, parseDocument, type Node, type Pair, type YAMLMap } from 'yaml';
import { parseDuration, type SourceMap } from './source.js';
import type { CastId, CastMember, Diagnostic, VoiceRef } from './types.js';

export const DEFAULT_GAP_MS = 400;
const TOP_KEYS = new Set(['title', 'author', 'language', 'gap', 'narrator', 'cast']);
const MEMBER_KEYS = new Set(['voice', 'delivery', 'look']);
const NARRATOR_KEYS = new Set(['voice', 'delivery']);

export interface FrontMatter {
  title: string;
  author?: string;
  language: string;
  gapMs: number;
  narrator: CastId;
  cast: Record<CastId, CastMember>;
}

export interface FrontMatterResult {
  frontMatter?: FrontMatter;
  /** Offset where the body starts, after the closing `---` line. */
  bodyStart: number;
  diagnostics: Diagnostic[];
}

/** Splits the leading `---` block from a story and validates it. */
export function readFrontMatter(markdown: string, map: SourceMap): FrontMatterResult {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    return {
      bodyStart: 0,
      diagnostics: [{
        code: 'missing-front-matter',
        severity: 'error',
        message: 'A story starts with a front matter block between two --- lines, with at least title, narrator and cast.',
        source: map.range(0, Math.min(markdown.indexOf('\n') >>> 0, markdown.length)),
      }],
    };
  }

  const yamlStart = match[0].indexOf(match[1]!);
  const bodyStart = match[0].length;
  const diagnostics: Diagnostic[] = [];
  const at = (node: Node | null | undefined, fallback: [number, number] = [0, 3]) => {
    const [s, e] = node?.range ? [node.range[0], node.range[1]] : [fallback[0] - yamlStart, fallback[1] - yamlStart];
    return map.range(yamlStart + s, yamlStart + e);
  };
  const report = (code: Diagnostic['code'], message: string, node?: Node | null, fallback?: [number, number]) =>
    diagnostics.push({ code, severity: 'error', message, source: at(node, fallback) });

  const doc = parseDocument(match[1]!, { prettyErrors: false });
  for (const error of doc.errors) {
    diagnostics.push({
      code: 'bad-yaml',
      severity: 'error',
      message: error.message.split('\n')[0]!,
      source: map.range(yamlStart + error.pos[0], yamlStart + error.pos[1]),
    });
  }
  if (diagnostics.length) return { bodyStart, diagnostics };

  const root = doc.contents;
  if (!isMap(root)) {
    report('bad-yaml', 'Front matter must be a set of keys, such as title: and cast:.', root as Node | null);
    return { bodyStart, diagnostics };
  }

  const entries = pairs(root);
  for (const [key, pair] of entries) {
    if (!TOP_KEYS.has(key)) report('unknown-key', `Unknown front matter key "${key}". Allowed: ${[...TOP_KEYS].join(', ')}.`, pair.key as Node);
  }

  const title = stringValue(entries.get('title'));
  if (!title) report('missing-field', 'Front matter needs a title.', entries.get('title')?.key as Node | undefined);

  const author = stringValue(entries.get('author'));
  const language = stringValue(entries.get('language')) ?? 'en';

  let gapMs = DEFAULT_GAP_MS;
  const gapPair = entries.get('gap');
  if (gapPair) {
    const parsed = parseDuration(String(scalar(gapPair.value) ?? ''));
    if (parsed === undefined) report('bad-duration', 'gap must be a duration such as 400ms, 1.5s or 0:02.', gapPair.value as Node);
    else gapMs = parsed;
  }

  const cast: Record<CastId, CastMember> = {};
  const castPair = entries.get('cast');
  if (castPair) {
    if (!isMap(castPair.value)) report('missing-field', 'cast must list characters, each with a voice.', castPair.key as Node);
    else {
      for (const [name, memberPair] of pairs(castPair.value)) {
        const member = readMember(name.toUpperCase(), memberPair, MEMBER_KEYS, report);
        if (member) cast[member.id] = member;
      }
    }
  }

  let narrator: CastId = 'NARRATOR';
  const narratorPair = entries.get('narrator');
  if (!narratorPair) {
    report('missing-field', 'Front matter needs a narrator: a cast member\'s name, or a voice and delivery.');
  } else if (isScalar(narratorPair.value)) {
    narrator = String(narratorPair.value.value).toUpperCase();
    if (!cast[narrator]) report('unknown-speaker', `The narrator "${narratorPair.value.value}" is not in the cast.`, narratorPair.value as Node);
  } else {
    const member = readMember('NARRATOR', narratorPair, NARRATOR_KEYS, report);
    if (member) cast.NARRATOR = member;
  }

  if (diagnostics.length) return { bodyStart, diagnostics };
  return { frontMatter: { title: title!, author, language, gapMs, narrator, cast }, bodyStart, diagnostics };
}

type Report = (code: Diagnostic['code'], message: string, node?: Node | null) => void;

function readMember(id: CastId, pair: Pair, allowed: Set<string>, report: Report): CastMember | undefined {
  if (!isMap(pair.value)) {
    report('missing-field', `${id} needs a voice.`, pair.key as Node);
    return undefined;
  }
  const fields = pairs(pair.value);
  for (const [key, field] of fields) {
    if (!allowed.has(key)) report('unknown-key', `Unknown key "${key}" for ${id}. Allowed: ${[...allowed].join(', ')}.`, field.key as Node);
  }
  const voice = voiceValue(fields.get('voice'));
  if (!voice) {
    report('missing-field', `${id} needs a voice.`, pair.key as Node);
    return undefined;
  }
  return {
    id,
    voice,
    delivery: stringValue(fields.get('delivery')) ?? '',
    ...(stringValue(fields.get('look')) ? { look: stringValue(fields.get('look')) } : {}),
  };
}

function pairs(map: YAMLMap): Map<string, Pair> {
  const out = new Map<string, Pair>();
  for (const item of map.items) out.set(String(scalar(item.key) ?? ''), item);
  return out;
}

function scalar(node: unknown): unknown {
  return isScalar(node) ? node.value : undefined;
}

function stringValue(pair: Pair | undefined): string | undefined {
  const value = scalar(pair?.value);
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function voiceValue(pair: Pair | undefined): VoiceRef | undefined {
  if (!pair) return undefined;
  if (isMap(pair.value)) {
    const fields = pairs(pair.value);
    const provider = stringValue(fields.get('provider'));
    const id = stringValue(fields.get('id'));
    if ((provider === 'gemini' || provider === 'elevenlabs') && id) return { provider, id };
    return undefined;
  }
  return stringValue(pair);
}
