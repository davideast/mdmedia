import { stringify } from 'yaml';

/** What the cast pass decides about the whole story. */
export interface CastPlan {
  title: string;
  author?: string;
  narrator: { character: string } | { delivery: string; brief: string; voice?: string };
  cast: Record<string, { delivery: string; brief: string; look?: string; voice?: string }>;
  names: string[];
  scenes: Array<{ title: string; firstWords: string; music: string }>;
  /** Moments the author tells that are better shown: the exact sentence and the line that replaces it. */
  dramatize?: Array<{ sentence: string; speaker: string; cue: string; line: string }>;
}

export interface SceneDraft {
  title: string;
  music?: string;
  /** The scene's notation, without its heading or music block. */
  body: string;
}

/**
 * The story file: front matter from the cast plan, the title as a chapter
 * heading (displayed, never spoken), then each scene under its `###`
 * heading with its music cue.
 */
export function assembleStory(plan: CastPlan, scenes: SceneDraft[]): string {
  const frontMatter: Record<string, unknown> = { title: plan.title };
  if (plan.author) frontMatter.author = plan.author;
  frontMatter.narrator =
    'character' in plan.narrator
      ? plan.narrator.character
      : { ...(plan.narrator.voice ? { voice: plan.narrator.voice } : {}), delivery: plan.narrator.delivery, brief: plan.narrator.brief };
  frontMatter.cast = Object.fromEntries(
    Object.entries(plan.cast).map(([id, member]) => [
      id,
      { ...(member.voice ? { voice: member.voice } : {}), delivery: member.delivery, brief: member.brief, ...(member.look ? { look: member.look } : {}) },
    ])
  );
  if (plan.names.length) frontMatter.names = plan.names;

  const parts = [`---\n${stringify(frontMatter, { lineWidth: 0 }).trimEnd()}\n---`, `# ${plan.title}`];
  for (const scene of scenes) {
    parts.push(`### ${scene.title}`);
    if (scene.music) parts.push('```music\n' + scene.music.trim() + '\n```');
    parts.push(separateComments(scene.body));
  }
  return parts.join('\n\n') + '\n';
}

/**
 * Puts every `<!-- … -->` comment in a paragraph of its own. A comment written
 * on the line next to a line of dialogue could otherwise swallow it.
 */
export function separateComments(body: string): string {
  return body
    .replace(/[ \t]*(<!--[\s\S]*?-->)[ \t]*/g, '\n\n$1\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Replaces a told sentence with a shown line: the sentence is kept in a
 * `<!-- replaced: "…" -->` comment where it was, and the new line follows,
 * marked `<!-- director: added -->`. Text around the sentence in the same
 * paragraph stays, with the paragraph's cue. Returns the body unchanged when
 * the sentence is not in it.
 */
export function applyDramatization(body: string, d: { sentence: string; speaker: string; cue: string; line: string }): string {
  const paragraphs = body.split(/\n\s*\n/);
  const index = paragraphs.findIndex((p) => p.includes(d.sentence));
  if (index < 0) return body;
  const paragraph = paragraphs[index]!;
  const cue = /^\*\(([^)]*)\)\*\s*/.exec(paragraph);
  const at = paragraph.indexOf(d.sentence);
  const before = paragraph.slice(0, at).replace(/^\*\([^)]*\)\*\s*/, '').trim();
  const after = paragraph.slice(at + d.sentence.length).trim();
  const withCue = (text: string) => (cue ? `${cue[0].trim()} ${text}` : text);
  const replacement = [
    ...(before ? [withCue(before)] : []),
    `<!-- replaced: "${d.sentence}" -->`,
    '<!-- director: added -->',
    `**${d.speaker}** *(${d.cue})*: ${d.line}`,
    ...(after ? [withCue(after)] : []),
  ];
  return [...paragraphs.slice(0, index), ...replacement, ...paragraphs.slice(index + 1)].join('\n\n');
}

/** Where each `### ` heading starts, 1-based, in an assembled story. */
export function sceneHeadingLines(markdown: string): number[] {
  return markdown.split('\n').flatMap((line, i) => (line.startsWith('### ') ? [i + 1] : []));
}
