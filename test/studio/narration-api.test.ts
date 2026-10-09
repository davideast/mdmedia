import { describe, expect, it } from 'bun:test';
import {
  generateApiKey,
  generateUserCode,
  normalizeUserCode,
  parseApiKey,
  secretMatches,
} from '../../studio/src/lib/api-key-token';
import { MAX_MARKDOWN_CHARS, resolveNarrationBody, toNarrationResource } from '../../studio/src/lib/narration-api';
import { createRateLimiter } from '../../studio/src/lib/rate-limit';
import { DEFAULT_SETTINGS, type Narration, type UserSettings } from '../../studio/src/lib/types';

const settings: UserSettings = {
  ...DEFAULT_SETTINGS,
  defaultVoice: 'Kore',
  defaultVoiceRef: { provider: 'gemini', id: 'Kore' },
  defaultPromptStyle: 'Creative. Calm. Intelligent. Interested.',
  deliveryPresets: [{ id: 'saved-default', name: 'My default', text: 'Creative. Calm. Intelligent. Interested.' }],
  instructionPresets: [{ id: 'saved-brief', name: 'Brief', text: 'Keep it short.' }],
  structureMarkdown: true,
  defaultVisibility: 'public',
};

const resolve = (body: unknown, restricted = true) => resolveNarrationBody(body, settings, { restricted });

describe('API keys', () => {
  it('round-trips a generated key and matches only its own secret', () => {
    const key = generateApiKey();
    expect(key.token.startsWith('mdm_')).toBe(true);
    const parsed = parseApiKey(key.token)!;
    expect(parsed.keyId).toBe(key.keyId);
    expect(secretMatches(parsed.secret, key.hash)).toBe(true);
    expect(secretMatches(generateApiKey().secret, key.hash)).toBe(false);
  });

  it('rejects malformed keys and ID tokens', () => {
    expect(parseApiKey('eyJhbGciOi.payload.sig')).toBeNull();
    expect(parseApiKey('mdm_short_secret')).toBeNull();
    expect(parseApiKey(`${generateApiKey().token}x`)).toBeNull();
  });

  it('normalizes the code a person types', () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeUserCode(code.toLowerCase().replace('-', ' '))).toBe(code);
    expect(normalizeUserCode('O0O0-1111')).toBeNull();
  });
});

describe('POST /api/v1/narrations body', () => {
  it('fills every omitted option from the caller\'s settings', () => {
    const result = resolve({ markdown: '# Hello\n\nWorld.' });
    if (!result.ok) throw new Error(result.message);
    expect(result.request).toMatchObject({
      voice: 'Kore', voiceProvider: 'gemini', model: settings.defaultGeminiModel,
      promptStyle: settings.defaultPromptStyle, rewriteForNarration: true,
      rewriteInstructions: settings.defaultRewriteInstructions.trim(), structureMarkdown: true, verbalizeDiagrams: false,
    });
  });

  it('keeps API-key narrations private even when the default is public', () => {
    const fromKey = resolve({ markdown: 'Hi' });
    expect(fromKey.ok && fromKey.request.visibility).toBe('private');
    expect(resolve({ markdown: 'Hi', visibility: 'public' })).toMatchObject({ ok: false, status: 403, code: 'visibility_not_allowed' });
    const fromBrowser = resolve({ markdown: 'Hi' }, false);
    expect(fromBrowser.ok && fromBrowser.request.visibility).toBe('public');
  });

  it('resolves presets by name or id and voices by name, case-insensitively', () => {
    const result = resolve({ markdown: 'Hi', voice: 'puck', deliveryPreset: 'documentary', instructionsPreset: 'saved-brief' });
    if (!result.ok) throw new Error(result.message);
    expect(result.request.voice).toBe('Puck');
    expect(result.request.promptStyle).toContain('documentary');
    expect(result.request.rewriteInstructions).toBe('Keep it short.');
  });

  it('accepts an ElevenLabs voice id for the route to authorize', () => {
    const result = resolve({ markdown: 'Hi', voice: { provider: 'elevenlabs', id: 'AbCdEfGhIjKlMnOpQrSt' } });
    expect(result.ok && result.request.voiceProvider).toBe('elevenlabs');
  });

  it('explains what is wrong instead of a generic failure', () => {
    expect(resolve({})).toMatchObject({ code: 'missing_markdown' });
    expect(resolve({ markdown: 'x'.repeat(MAX_MARKDOWN_CHARS + 1) })).toMatchObject({ code: 'markdown_too_long' });
    expect(resolve({ markdown: 'Hi', voices: 'Puck' })).toMatchObject({ code: 'unknown_fields' });
    expect(resolve({ markdown: 'Hi', voice: 'Nobody' })).toMatchObject({ code: 'invalid_voice' });
    expect(resolve({ markdown: 'Hi', deliveryPreset: 'Missing' })).toMatchObject({ code: 'unknown_preset' });
    expect(resolve({ markdown: 'Hi', delivery: 'x', deliveryPreset: 'Documentary' })).toMatchObject({ code: 'conflicting_fields' });
    expect(resolve({ markdown: 'Hi', speed: 4 })).toMatchObject({ code: 'invalid_speed' });
    expect(resolve({ markdown: 'Hi', model: 'gpt' })).toMatchObject({ code: 'invalid_model' });
  });
});

describe('narration resource', () => {
  it('links audio only once the narration is ready, and surfaces errors', () => {
    const base = { id: 'abcdefghij', title: 'T', visibility: 'private', voice: 'Kore', adapted: true, durationMs: 0, createdAt: 1, updatedAt: 2 } as Narration;
    expect(toNarrationResource({ ...base, status: 'streaming' }, 'http://x').links.audio).toBeNull();
    expect(toNarrationResource({ ...base, status: 'ready' }, 'http://x').links.audio).toBe('http://x/api/v1/narrations/abcdefghij/audio');
    expect(toNarrationResource({ ...base, status: 'error', errorMessage: 'Quota' }, 'http://x').error).toMatchObject({ message: 'Quota' });
  });
});

describe('rate limiter', () => {
  it('allows the limit, then reports the wait until the oldest hit expires', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.take('k')).toBe(0);
    now = 100;
    expect(limiter.take('k')).toBe(0);
    expect(limiter.take('k')).toBe(900);
    expect(limiter.take('other')).toBe(0);
    now = 1001;
    expect(limiter.take('k')).toBe(0);
  });
});
