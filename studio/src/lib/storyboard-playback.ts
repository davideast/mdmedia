import type { StoryBeat, StoryboardView } from './storyboard';

export function beatReadingText(beat: StoryBeat, view: StoryboardView): string {
  return (view === 'script' ? beat.script : beat.summary || beat.script).trim();
}
