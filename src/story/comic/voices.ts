import { renderLines, type LineEvent, type RenderedLine, type RenderLinesOptions } from '../render-lines.js';
import type { Line, StoryScript } from '../types.js';
import type { ComicScript } from './types.js';

/** An item's id: `3.2` panel, item 0 → `3.2-0`. Stable while the panel's items keep their order. */
export const itemId = (panelId: string, index: number) => `${panelId}-${index}`;

/**
 * The comic's captions and balloons as a story script, so milestone 1's voices
 * render them unchanged: each page is a scene (the context for the delivery
 * note), a caption is spoken by the story's narrator, and a balloon by its
 * speaker with its own cue. Sound effects are lettered, not voiced.
 */
export function comicScript(comic: ComicScript, story: StoryScript): StoryScript {
  return {
    schema: 'mdmedia.story.script/1',
    source: comic.source,
    meta: { ...story.meta, title: comic.meta.title },
    gapMs: story.gapMs,
    narrator: story.narrator,
    cast: story.cast,
    chapters: [
      {
        id: 'comic',
        index: 1,
        scenes: comic.pages.map((page) => ({
          id: `page-${page.index}`,
          index: page.index,
          segments: page.panels.flatMap((panel) =>
            panel.items.flatMap((item, i): Line[] =>
              item.kind === 'sfx'
                ? []
                : [
                    {
                      kind: 'line',
                      id: itemId(panel.id, i),
                      speaker: item.kind === 'caption' ? story.narrator : item.who,
                      narration: item.kind === 'caption',
                      cue: item.cue,
                      text: item.text,
                      display: item.display,
                      source: item.source,
                    },
                  ]
            )
          ),
        })),
      },
    ],
  };
}

export type ComicVoiceEvent = LineEvent;

/** Voices every caption and balloon, checked and cached like the audio drama's lines. Keyed by itemId. */
export async function voiceComic(comic: ComicScript, story: StoryScript, options: RenderLinesOptions): Promise<Map<string, RenderedLine>> {
  return renderLines(comicScript(comic, story), options);
}
