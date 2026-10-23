import { lexer, type Token, type Tokens } from 'marked';
import { readFrontMatter } from './front-matter.js';
import { parseDuration, SourceMap } from './source.js';
import type { CastId, Chapter, Diagnostic, Line, Scene, StoryScript } from './types.js';

export interface ParseResult {
  /** Present only when there are no errors; warnings do not stop parsing. */
  script?: StoryScript;
  diagnostics: Diagnostic[];
}

/** A line of dialogue: `**NAME** *(cue)*: text` or `**NAME**: text`. */
const LINE = /^\*\*([^*\n]+)\*\*[ \t]*(?:\*\(([^)\n]*)\)\*)?[ \t]*:[ \t]*([\s\S]*)$/;
/** A narration paragraph that starts with its own cue: `*(cue)* text`. */
const NARRATION_CUE = /^\*\(([^)\n]*)\)\*[ \t]+([\s\S]*)$/;

/**
 * Parses a story file into a script. Pure: no I/O, no Node imports, so it runs
 * in a browser too. Async only because hashing uses Web Crypto.
 */
export async function parseStory(markdown: string, options: { path: string }): Promise<ParseResult> {
  const map = new SourceMap(markdown);
  const { frontMatter, bodyStart, diagnostics } = readFrontMatter(markdown, map);
  if (!frontMatter) return { diagnostics };

  const body = markdown.slice(bodyStart);
  const tokens = lexer(body);
  const chapters: Chapter[] = [];
  let chapter: Chapter = newChapter(0);
  let scene: Scene = newScene(chapter, 0);
  let lineInScene = 0;
  const error = (code: Diagnostic['code'], message: string, start: number, end: number) =>
    diagnostics.push({ code, severity: 'error', message, source: map.range(start, end) });

  const startChapter = (title: string) => {
    closeChapter();
    chapter = newChapter(chapters.length, title);
    scene = newScene(chapter, 0);
    lineInScene = 0;
  };
  const startScene = (title?: string) => {
    if (scene.segments.length || scene.music || scene.title || scene.subtitle) chapter.scenes.push(scene);
    scene = newScene(chapter, chapter.scenes.length, title);
    lineInScene = 0;
  };
  function closeChapter() {
    if (scene.segments.length || scene.music || scene.title || scene.subtitle) chapter.scenes.push(scene);
    if (chapterHasContent(chapter)) chapters.push(chapter);
  }
  const segmentId = (suffix: string) => `${scene.id}/${String(++lineInScene).padStart(4, '0')}-${suffix}`;
  const hasLines = () => scene.segments.some((s) => s.kind === 'line');

  const pushLine = (speaker: CastId, narration: boolean, cue: string, content: string, start: number, end: number) => {
    const line: Line = {
      kind: 'line',
      id: segmentId(speaker.toLowerCase()),
      speaker,
      narration,
      cue: cue.trim(),
      text: spoken(content),
      display: content.trim(),
      source: map.range(start, end),
    };
    scene.segments.push(line);
    if (!line.cue) {
      diagnostics.push({
        code: 'missing-cue',
        severity: 'warning',
        message: narration
          ? 'Narration with no cue. Start the paragraph with *(how it is said)* so it is voiced in context.'
          : `${speaker}'s line has no cue. Add *(how it is said)* after the name so it is voiced in context.`,
        source: line.source,
      });
    }
  };

  let offset = bodyStart;
  for (const token of tokens as Token[]) {
    const start = offset;
    const end = offset + token.raw.length;
    offset = end;
    const trimmedEnd = start + token.raw.trimEnd().length;

    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        if (heading.depth === 1) startChapter(plain(heading.text));
        else if (heading.depth === 3) startScene(plain(heading.text));
        else if (heading.depth === 2) scene.subtitle = plain(heading.text);
        break;
      }
      case 'hr':
        startScene();
        break;
      case 'code': {
        const code = token as Tokens.Code;
        if (code.lang === 'pause') {
          const durationMs = parseDuration(code.text);
          if (durationMs === undefined) error('bad-duration', `A pause needs a duration such as 1.5s, 1500ms or 0:02, not "${code.text.trim()}".`, start, trimmedEnd);
          else scene.segments.push({ kind: 'pause', id: segmentId('pause'), durationMs, source: map.range(start, trimmedEnd) });
        } else if (code.lang === 'music') {
          if (hasLines() || scene.music) error('misplaced-music', 'A music cue goes at the start of a scene, before its first line.', start, trimmedEnd);
          else scene.music = code.text.trim();
        }
        break;
      }
      case 'paragraph': {
        const raw = token.raw.trim();
        const line = LINE.exec(raw);
        if (line) {
          const name = line[1]!.trim().toUpperCase();
          if (!frontMatter.cast[name]) {
            const nameStart = start + token.raw.indexOf(line[1]!);
            error('unknown-speaker', `${line[1]!.trim()} is not in the cast.`, nameStart, nameStart + line[1]!.length);
            break;
          }
          pushLine(name, false, line[2] ?? '', line[3]!, start, trimmedEnd);
          break;
        }
        const cued = NARRATION_CUE.exec(raw);
        pushLine(frontMatter.narrator, true, cued?.[1] ?? '', cued ? cued[2]! : raw, start, trimmedEnd);
        break;
      }
      case 'list': {
        const list = token as Tokens.List;
        pushLine(frontMatter.narrator, true, '', list.items.map((i) => i.text.trim()).join('\n'), start, trimmedEnd);
        break;
      }
      case 'blockquote': {
        pushLine(frontMatter.narrator, true, '', (token as Tokens.Blockquote).text, start, trimmedEnd);
        break;
      }
      default:
        break; // space, html, tables and other blocks are not spoken
    }
  }
  closeChapter();

  if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics };

  const script: StoryScript = {
    schema: 'mdmedia.story.script/1',
    source: { path: options.path, sha256: await sha256(markdown) },
    meta: {
      title: frontMatter.title,
      ...(frontMatter.author ? { author: frontMatter.author } : {}),
      language: frontMatter.language,
      ...(frontMatter.names.length ? { names: frontMatter.names } : {}),
    },
    gapMs: frontMatter.gapMs,
    narrator: frontMatter.narrator,
    cast: frontMatter.cast,
    chapters,
  };
  return { script, diagnostics };
}

function newChapter(index: number, title?: string): Chapter {
  return { id: String(index).padStart(2, '0'), index, ...(title ? { title } : {}), scenes: [] };
}

function newScene(chapter: Chapter, index: number, title?: string): Scene {
  return { id: `${chapter.id}/${String(index).padStart(2, '0')}`, index, ...(title ? { title } : {}), segments: [] };
}

function chapterHasContent(chapter: Chapter): boolean {
  return Boolean(chapter.title) || chapter.scenes.length > 0;
}

/** Inline markdown removed, whitespace collapsed: the words a voice says. */
function spoken(markdown: string): string {
  return plain(markdown).replace(/\s+/g, ' ').trim();
}

function plain(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
