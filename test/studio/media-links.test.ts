import { describe, expect, it } from 'bun:test';
import {
  MEDIA_LINK_STEP_MS,
  MEDIA_LINK_TTL_MS,
  mediaLinkExpiry,
  mediaLinkQuery,
  mediaLinkSecret,
  presentedLink,
  signMediaLink,
  verifyMediaLink,
} from '../../studio/src/lib/media-links';

const secret = Buffer.from('a test secret that is long enough to use', 'utf8');
const now = Date.UTC(2026, 9, 19, 12, 1, 0);
const claim = { assetId: 'pmasset1', ownerUid: 'owner', exp: mediaLinkExpiry(now) };

describe('signed media links', () => {
  it('live 15 to 20 minutes, rounded so links made close together are the same', () => {
    const exp = mediaLinkExpiry(now) * 1000;
    expect(exp - now).toBeGreaterThanOrEqual(MEDIA_LINK_TTL_MS);
    expect(exp - now).toBeLessThanOrEqual(MEDIA_LINK_TTL_MS + MEDIA_LINK_STEP_MS);
    expect(exp % MEDIA_LINK_STEP_MS).toBe(0);
    expect(mediaLinkExpiry(now + 60_000)).toBe(mediaLinkExpiry(now));
    expect(mediaLinkQuery(secret, claim)).toBe(mediaLinkQuery(secret, { ...claim }));
  });

  it('open the asset they were signed for, until they expire', () => {
    const sig = signMediaLink(secret, claim);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyMediaLink(secret, claim, sig, now)).toBe('ok');
    expect(verifyMediaLink(secret, claim, sig, claim.exp * 1000 - 1)).toBe('ok');
    expect(verifyMediaLink(secret, claim, sig, claim.exp * 1000)).toBe('expired');
    expect(verifyMediaLink(secret, claim, sig, claim.exp * 1000 + 3_600_000)).toBe('expired');
  });

  it('refuse another asset, another owner, a changed expiry, a tampered signature or another secret', () => {
    const sig = signMediaLink(secret, claim);
    expect(verifyMediaLink(secret, { ...claim, assetId: 'pmasset2' }, sig, now)).toBe('invalid');
    expect(verifyMediaLink(secret, { ...claim, ownerUid: 'intruder' }, sig, now)).toBe('invalid');
    expect(verifyMediaLink(secret, { ...claim, exp: claim.exp + 300 }, sig, now)).toBe('invalid');
    const flipped = `${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`;
    expect(verifyMediaLink(secret, claim, flipped, now)).toBe('invalid');
    expect(verifyMediaLink(secret, claim, sig.slice(1), now)).toBe('invalid');
    expect(verifyMediaLink(secret, claim, '', now)).toBe('invalid');
    expect(verifyMediaLink(Buffer.from('another secret, also long enough to use', 'utf8'), claim, sig, now)).toBe('invalid');
  });

  it('refuse a validly signed link that claims to live far longer than links do', () => {
    const far = { ...claim, exp: Math.floor(now / 1000) + 24 * 3600 };
    expect(verifyMediaLink(secret, far, signMediaLink(secret, far), now)).toBe('invalid');
  });

  it('read exp and sig from a query, and nothing when there is no link', () => {
    expect(presentedLink(new URLSearchParams('thumbnail=1'))).toBeNull();
    expect(presentedLink(new URLSearchParams('exp=1792432800&sig=abc'))).toEqual({ exp: 1792432800, sig: 'abc' });
    expect(presentedLink(new URLSearchParams('sig=abc'))).toBe('invalid');
    expect(presentedLink(new URLSearchParams('exp=soon&sig=abc'))).toBe('invalid');
  });

  it('use the configured secret, else one random secret per process', () => {
    expect(mediaLinkSecret({ MDMEDIA_MEDIA_LINK_SECRET: 'x'.repeat(40) }).toString()).toBe('x'.repeat(40));
    const fallback = mediaLinkSecret({});
    expect(fallback.length).toBe(32);
    expect(mediaLinkSecret({}).equals(fallback)).toBe(true);
  });
});

it('serves a signed byte range to a player, and refuses expired, tampered and wrong-asset links', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/media-links-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ passed: true });
}, 60_000);
