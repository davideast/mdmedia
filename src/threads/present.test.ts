import { describe, expect, it } from 'bun:test';
import { resolveCut } from '../cut/resolve.js';
import type { CutFile, Timeline } from '../cut/types.js';
import { agentPresent, anchorAt, anchorPhrase, optionLetter, previewLabel, quoteLine, statusLine, timedLabel, waitingOptions, wordsAround } from './present.js';
import type { Suggestion, Thread } from './types.js';

/**
 * A small cut shaped like Big Hal's punchline: the hood shot, then the
 * finish; "This one even comes with..." over the hood, a pause, and
 * "Wheels!" over the cut into the finish. (Big Hal's own cut file changes as
 * it is worked on, so these tests own their timeline.)
 */
function punchline(): Timeline {
  const cut: CutFile = {
    format: 'mdmedia.cut@1',
    meta: { title: 'Big Hal', fps: 24, width: 64, height: 48 },
    media: { root: '/media' },
    segments: [{ id: 'hood', src: 'color:black', in: 0, out: 2 }, { id: 'finish', src: 'color:black', in: 0, out: 1 }],
    lines: [
      { id: 'thisone', speaker: 'Hal', text: 'And this one? This one even comes with...', src: 'asset:a', at: 0.2, duration: 1 },
      { id: 'wheels', speaker: 'Hal', text: 'Wheels!', src: 'asset:b', at: 1.8, duration: 0.8 },
    ],
    overlays: [{ id: 'included', src: 'asset:c', at: 1.9, until: 3 }],
  } as CutFile;
  const resolved = resolveCut(cut, { root: '/media' });
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('\n'));
  return resolved.value;
}

const option = (over: Partial<Suggestion>): Suggestion => ({
  id: 's', threadId: 't', author: 'agent:editor', round: 1, letter: 'A', title: 'x', approach: '', steps: [], cost: { generations: 0, minutes: 0 }, risks: [], checks: [],
  previews: [], keeps: [], overturns: [], creates: [], state: 'proposed', createdAt: 0, ...over,
});
const take = (id: string) => ({ take5: 'Take 5', take6: 'Take 6' })[id] ?? id;

describe('anchors as a comment records them', () => {
  it('records the items under the playhead with their times then', () => {
    const items = anchorAt(punchline(), 1.5);
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['segment:hood', 'line:thisone', 'line:wheels', 'gap:thisone-wheels']);
    expect(items[0]).toEqual({ kind: 'segment', id: 'hood', start: 0, end: 2 });
    expect(items.find((i) => i.kind === 'gap')).toEqual({ kind: 'gap', id: 'thisone-wheels', start: 1.2, end: 1.8 });
    expect(anchorAt(punchline(), 2.2).map((i) => `${i.kind}:${i.id}`)).toEqual(['segment:finish', 'line:thisone', 'line:wheels', 'gap:thisone-wheels', 'overlay:included']);
  });

  it('says where a comment is in plain words', () => {
    const timeline = punchline();
    expect(anchorPhrase(timeline, [], 1.5)).toBe('in the pause before “Wheels!” · hood shot');
    expect(anchorPhrase(timeline, [], 2.2)).toBe('during “Wheels!” · finish shot');
    expect(anchorPhrase(timeline, [], 0.5)).toBe('during “And this one? This one…” · hood shot');
    expect(anchorPhrase(timeline, [], 0.1)).toBe('before “And this one? This one…” · hood shot');
    expect(anchorPhrase(timeline, [], 2.9)).toBe('after “Wheels!” · finish shot');
  });

  it('falls back on the anchor\'s own items and times when the cut is gone', () => {
    expect(anchorPhrase(null, anchorAt(punchline(), 2.2), 2.2)).toBe('during line wheels · finish shot');
    expect(anchorPhrase(null, anchorAt(punchline(), 1.5), 1.5)).toBe('in the pause before line wheels · hood shot');
  });

  it('hears the words around the playhead', () => {
    // Lines without word timings have none to hear.
    expect(wordsAround(punchline(), 2.2, 1)).toEqual([]);
  });

  it('shortens a long line to its first words', () => {
    expect(quoteLine('And this one? This one even comes with...')).toBe('“And this one? This one…”');
    expect(quoteLine('Wheels!')).toBe('“Wheels!”');
  });
});

describe('plain labels', () => {
  it('letters options A to Z, then AA', () => {
    expect([0, 1, 25, 26, 27].map(optionLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
  });

  it('names previews by their option, and the extra ones by what tells them apart', () => {
    const s = option({ letter: 'A', round: 2, previews: [{ assetId: 'p1' }, { assetId: 'p2', label: 'without the level ride' }, { assetId: 'p3' }] });
    expect(previewLabel(s, 'p1')).toBe('Option A · round 2');
    expect(previewLabel(s, 'p2')).toBe('Option A · round 2 · without the level ride');
    expect(previewLabel(s, 'p3')).toBe('Option A · round 2 · preview 3');
  });

  it('says which video every time is on', () => {
    const s = option({ id: 's4', letter: 'A', round: 2, previews: [{ assetId: 'p1' }] });
    expect(timedLabel({ video: { kind: 'cut', cutId: 'take5' }, time: 21.8 }, take, () => undefined)).toBe('Take 5 · 21.8 s');
    expect(timedLabel({ video: { kind: 'preview', suggestionId: 's4', assetId: 'p1' }, time: 15.02 }, take, (id) => (id === 's4' ? s : undefined))).toBe('Option A · round 2 · 15.0 s');
  });
});

describe('one status line per thread', () => {
  const thread = (over: Partial<Pick<Thread, 'status' | 'claim'>>): Pick<Thread, 'status' | 'claim'> => ({ status: 'open', claim: null, ...over });
  const now = 1_000_000;

  it('reads what the thread waits for from its status, claim and options', () => {
    expect(statusLine(thread({}), [], take, now)).toEqual({ tone: 'waiting', text: 'Waiting for an agent' });
    expect(statusLine(thread({ status: 'in-progress', claim: { agent: 'editor', at: 0, expiresAt: now + 1 } }), [], take, now)).toEqual({ tone: 'working', text: 'Agent working' });
    expect(statusLine(thread({ status: 'in-progress', claim: { agent: 'editor', at: 0, expiresAt: now - 1 } }), [], take, now).text).toBe('In progress');
    const round2 = [option({ id: 'a', round: 2 }), option({ id: 'b', round: 2, letter: 'B' }), option({ id: 'c', round: 1, state: 'rejected' })];
    expect(statusLine(thread({ status: 'addressed' }), round2, take, now)).toEqual({ tone: 'needs-you', text: '2 options to review' });
    expect(statusLine(thread({ status: 'open' }), [option({ state: 'accepted', round: 2 })], take, now).text).toBe('You accepted Option A · round 2');
    expect(statusLine(thread({ status: 'addressed' }), [option({ state: 'applied', appliedAs: 'take6', round: 2 }), option({ id: 'b', letter: 'B', round: 2 })], take, now)).toEqual({ tone: 'needs-you', text: 'Addressed in Take 6' });
    expect(statusLine(thread({ status: 'addressed' }), [], take, now).text).toBe('The agent replied');
    expect(statusLine(thread({ status: 'resolved' }), round2, take, now)).toEqual({ tone: 'done', text: 'Resolved' });
  });

  it('waits on the latest round only, and not once an option in it is taken', () => {
    expect(waitingOptions([option({ id: 'old', round: 1 }), option({ id: 'new', round: 2 })]).map((s) => s.id)).toEqual(['new']);
    expect(waitingOptions([option({ id: 'a', round: 2, state: 'applied' }), option({ id: 'b', round: 2 })])).toEqual([]);
  });

  it('counts an agent as there while its heartbeat is fresh, for this production or all', () => {
    const now2 = 10 * 60_000;
    expect(agentPresent([{ agent: 'editor', productionId: null, seenAt: now2 - 60_000 }], 'pr1', now2)).toBe(true);
    expect(agentPresent([{ agent: 'editor', productionId: 'pr2', seenAt: now2 }], 'pr1', now2)).toBe(false);
    expect(agentPresent([{ agent: 'editor', productionId: 'pr1', seenAt: now2 - 5 * 60_000 }], 'pr1', now2)).toBe(false);
  });
});
