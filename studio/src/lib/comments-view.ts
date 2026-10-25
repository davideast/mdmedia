/**
 * How a thread reads in the Comments panel, top to bottom. Pure, so it is
 * tested on its own; the panel only draws what this decides.
 *
 * Only what needs the owner is shown. Rounds before the latest fold away
 * into one line, except the owner's own replies the latest round answers.
 * In the latest round, once an option is taken the others fold away; until
 * then, only turned-down options do. A reply about a time on a preview sits
 * under that preview when the preview is shown.
 */

import type { Message, Suggestion } from 'mdmedia/threads';

export interface OptionView {
  suggestion: Suggestion;
  /** Messages about a time on one of its previews, in order. */
  replies: Message[];
}

export interface MessageView {
  message: Message;
  /** The options this message offers that are shown. */
  options: OptionView[];
  /** Its options that folded away (turned down, or passed over for the one taken). */
  folded: Suggestion[];
}

export interface ConversationView {
  /** Earlier rounds, folded into one line until opened. */
  earlier: MessageView[];
  earlierRounds: number;
  /** Everything from the latest round on, in order. */
  shown: MessageView[];
}

const byTime = (a: Message, b: Message) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

function section(messages: readonly Message[], suggestions: readonly Suggestion[], latestRound: number, taken: boolean): MessageView[] {
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const views: MessageView[] = [];
  const placed = new Map<string, OptionView>();
  for (const message of messages) {
    const own = (message.suggestions ?? []).map((id) => byId.get(id)).filter((s): s is Suggestion => Boolean(s));
    const options: OptionView[] = [];
    const folded: Suggestion[] = [];
    for (const s of own) {
      const visible = s.round !== latestRound
        ? true
        : taken ? s.state === 'accepted' || s.state === 'applied' : s.state !== 'rejected';
      if (visible) {
        const view = { suggestion: s, replies: [] };
        options.push(view);
        placed.set(s.id, view);
      } else folded.push(s);
    }
    // A timed reply on a preview shown above it goes under that preview.
    const at = message.at?.video.kind === 'preview' ? placed.get(message.at.video.suggestionId) : undefined;
    if (at) {
      at.replies.push(message);
      continue;
    }
    views.push({ message, options, folded });
  }
  return views;
}

export function conversation(allMessages: readonly Message[], suggestions: readonly Suggestion[]): ConversationView {
  const messages = [...allMessages].sort(byTime);
  const latestRound = Math.max(0, ...suggestions.map((s) => s.round));
  const taken = suggestions.some((s) => s.round === latestRound && (s.state === 'accepted' || s.state === 'applied'));
  const start = latestRound === 0 ? -1 : messages.findIndex((m) => (m.suggestions ?? []).some((id) => suggestions.find((s) => s.id === id)?.round === latestRound));
  if (start <= 0) return { earlier: [], earlierRounds: 0, shown: section(messages, suggestions, latestRound, taken) };
  // Keep the owner's replies just before the latest round: that round answers them.
  let cut = start;
  while (cut > 0 && messages[cut - 1]!.author === 'owner') cut -= 1;
  const earlier = messages.slice(0, cut);
  const earlierRounds = new Set(suggestions.filter((s) => earlier.some((m) => m.suggestions?.includes(s.id))).map((s) => s.round)).size;
  return {
    earlier: section(earlier, suggestions, latestRound, taken),
    earlierRounds,
    shown: section(messages.slice(cut), suggestions, latestRound, taken),
  };
}
