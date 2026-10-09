import { STORY_REVIEW_CATEGORIES, type AudienceObservation } from '../../src/production';

// Explicit test doubles for review coverage, never evidence of real film quality.
export function audiencePass(): AudienceObservation {
  return {
    retelling: 'Test-only viewer retelling of the breakfast exchange.',
    understood: [{ claim: 'Test-only understanding of a relationship.', at: 1 }],
    uncertainties: [],
    checks: STORY_REVIEW_CATEGORIES.map(category => ({ category, verdict: 'pass', at: 1, evidence: 'Test-only audience observation.' })),
  };
}

// Minimal header for the real metadata reader; not a playable movie.
export function movieHeader(seconds: number): Buffer {
  const b = Buffer.alloc(36);
  b.writeUInt32BE(36, 0); b.write('moov', 4); b.writeUInt32BE(28, 8); b.write('mvhd', 12);
  b.writeUInt32BE(1000, 28); b.writeUInt32BE(Math.round(seconds * 1000), 32);
  return b;
}
