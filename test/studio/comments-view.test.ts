import { describe, expect, it } from 'bun:test';
import type { Message, Suggestion } from 'mdmedia/threads';
import { conversation } from '../../studio/src/lib/comments-view';

/**
 * The Comments panel shows only what needs the owner: earlier rounds fold
 * into one line, turned-down options and options passed over fold away, and
 * a reply about a time on a preview sits under that preview.
 */

const message = (id: string, author: string, createdAt: number, over: Partial<Message> = {}): Message => ({ id, threadId: 't', author, text: id, createdAt, ...over });
const option = (id: string, round: number, letter: string, state: Suggestion['state'] = 'proposed'): Suggestion => ({
  id, threadId: 't', author: 'agent:editor', round, letter, title: id, approach: '', steps: [], cost: { generations: 0, minutes: 0 }, risks: [], checks: [],
  previews: [{ assetId: `${id}-p` }], keeps: [], overturns: [], creates: [], state, createdAt: 0,
});

// The Personally thread as the simulation left it: three rounds, the owner's timed reply on round 2's Option A.
const personally = {
  messages: [
    message('m1', 'agent:editor', 1, { suggestions: ['s1', 's2', 's3'] }),
    message('m2', 'owner', 2, { replyTo: 'm1' }),
    message('m3', 'agent:editor', 3, { suggestions: ['s4', 's5', 's6'] }),
    message('m4', 'owner', 4, { at: { video: { kind: 'preview', suggestionId: 's4', assetId: 's4-p' }, time: 15.02 } }),
    message('m5', 'agent:editor', 5, { replyTo: 'm4', suggestions: ['s7'] }),
  ],
  suggestions: [
    option('s1', 1, 'A', 'rejected'), option('s2', 1, 'B', 'rejected'), option('s3', 1, 'C', 'rejected'),
    option('s4', 2, 'A'), option('s5', 2, 'B'), option('s6', 2, 'C'),
    option('s7', 3, 'A'),
  ],
};

describe('a thread as the Comments panel reads it', () => {
  it('folds earlier rounds, keeping the owner\'s reply the latest round answers', () => {
    const view = conversation(personally.messages, personally.suggestions);
    expect(view.earlierRounds).toBe(2);
    expect(view.earlier.map((m) => m.message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(view.shown.map((m) => m.message.id)).toEqual(['m4', 'm5']);
    expect(view.shown[1]!.options.map((o) => o.suggestion.id)).toEqual(['s7']);
  });

  it('puts a timed reply under the preview it is about when that preview is shown', () => {
    const view = conversation(personally.messages.slice(0, 4), personally.suggestions.slice(0, 6));
    const round2 = view.shown.find((m) => m.message.id === 'm3')!;
    expect(round2.options.find((o) => o.suggestion.id === 's4')!.replies.map((r) => r.id)).toEqual(['m4']);
    expect(view.shown.map((m) => m.message.id)).toEqual(['m2', 'm3']);
  });

  it('folds the options passed over once one is taken, and turned-down ones before that', () => {
    const wheels = {
      messages: [message('m3', 'agent:editor', 3, { suggestions: ['s4', 's5', 's6'] }), message('m4', 'agent:editor', 4, { replyTo: 'm3', version: { cutId: 'take6' } })],
      suggestions: [option('s4', 2, 'A', 'applied'), option('s5', 2, 'B'), option('s6', 2, 'C')],
    };
    const view = conversation(wheels.messages, wheels.suggestions);
    expect(view.shown[0]!.options.map((o) => o.suggestion.id)).toEqual(['s4']);
    expect(view.shown[0]!.folded.map((s) => s.id)).toEqual(['s5', 's6']);
    const open = conversation(wheels.messages.slice(0, 1), [option('s4', 2, 'A'), option('s5', 2, 'B', 'rejected')]);
    expect(open.shown[0]!.options.map((o) => o.suggestion.id)).toEqual(['s4']);
    expect(open.shown[0]!.folded.map((s) => s.id)).toEqual(['s5']);
  });

  it('shows everything when there is one round or none', () => {
    const view = conversation([message('m1', 'agent:editor', 1, { suggestions: ['s1'] }), message('m2', 'owner', 2)], [option('s1', 1, 'A')]);
    expect(view.earlier).toEqual([]);
    expect(view.shown.map((m) => m.message.id)).toEqual(['m1', 'm2']);
    expect(conversation([message('m1', 'owner', 1)], []).shown.map((m) => m.message.id)).toEqual(['m1']);
  });
});
