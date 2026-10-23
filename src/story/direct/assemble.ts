import { stringify } from 'yaml';

/** What the cast pass decides about the whole story. */
export interface CastPlan {
  title: string;
  author?: string;
  narrator: { character: string } | { voice: string; delivery: string };
  cast: Record<string, { voice: string; delivery: string; look?: string }>;
  names: string[];
  scenes: Array<{ title: string; firstWords: string; music: string }>;
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
  frontMatter.narrator = 'character' in plan.narrator ? plan.narrator.character : { voice: plan.narrator.voice, delivery: plan.narrator.delivery };
  frontMatter.cast = Object.fromEntries(
    Object.entries(plan.cast).map(([id, member]) => [
      id,
      { voice: member.voice, delivery: member.delivery, ...(member.look ? { look: member.look } : {}) },
    ])
  );
  if (plan.names.length) frontMatter.names = plan.names;

  const parts = [`---\n${stringify(frontMatter, { lineWidth: 0 }).trimEnd()}\n---`, `# ${plan.title}`];
  for (const scene of scenes) {
    parts.push(`### ${scene.title}`);
    if (scene.music) parts.push('```music\n' + scene.music.trim() + '\n```');
    parts.push(scene.body.trim());
  }
  return parts.join('\n\n') + '\n';
}

/** Where each `### ` heading starts, 1-based, in an assembled story. */
export function sceneHeadingLines(markdown: string): number[] {
  return markdown.split('\n').flatMap((line, i) => (line.startsWith('### ') ? [i + 1] : []));
}
