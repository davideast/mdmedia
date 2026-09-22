import { describe, expect, it } from 'bun:test';
import { classifyNarrationError } from '../../studio/src/lib/narration-errors.js';

describe('Narration Error Classification Suite', () => {
  describe('Policy & Content Filter Violations (400 prohibited_content)', () => {
    it('classifies Google Gemini 400 prohibited_content error with exact API payload structure', () => {
      const apiError = {
        status: 400,
        statusCode: 400,
        error: {
          message: "Input blocked: The prompt could not be submitted. The prompt contains sensitive words that violate Google's [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy). Try rephrasing the prompt.",
          code: 'prohibited_content',
        },
      };

      const classified = classifyNarrationError(apiError, {
        currentChunkIndex: 3,
        promptStyle: 'Adopt the persona of a world-weary 1940s noir detective.',
      });

      expect(classified.code).toBe('CONTENT_POLICY_VIOLATION');
      expect(classified.category).toBe('policy');
      expect(classified.retryable).toBe(false);
      expect(classified.chunkIndex).toBe(3);
      expect(classified.message).toContain('paragraph 4');
      expect(classified.actionableHint).toContain('delivery instructions');
      expect(classified.actionableHint).toContain('paragraph 4');
    });

    it('handles safety finish_reason or harm category flags', () => {
      const safetyError = new Error('Candidate was blocked due to finish_reason: SAFETY HARM_CATEGORY_HATE_SPEECH');
      const classified = classifyNarrationError(safetyError, { currentChunkIndex: 0 });

      expect(classified.code).toBe('CONTENT_POLICY_VIOLATION');
      expect(classified.category).toBe('policy');
      expect(classified.retryable).toBe(false);
      expect(classified.chunkIndex).toBe(0);
      expect(classified.message).toContain('paragraph 1');
    });

    it('works without promptStyle or chunkIndex context', () => {
      const apiError = {
        status: 400,
        error: { code: 'prohibited_content', message: 'Input blocked' },
      };
      const classified = classifyNarrationError(apiError);

      expect(classified.category).toBe('policy');
      expect(classified.chunkIndex).toBeUndefined();
      expect(classified.message).toContain('this section');
    });
  });

  describe('Quota & Rate Limiting (429)', () => {
    it('classifies 429 RESOURCE_EXHAUSTED as retryable quota error', () => {
      const quotaError = {
        status: 429,
        error: {
          code: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded for quota metric "Generate Requests" per minute',
        },
      };

      const classified = classifyNarrationError(quotaError);
      expect(classified.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(classified.category).toBe('quota');
      expect(classified.retryable).toBe(true);
    });
  });

  describe('Configuration & Auth Errors (401/403)', () => {
    it('classifies missing GEMINI_API_KEY as non-retryable config error', () => {
      const authError = new Error('API_KEY_INVALID: Please set GEMINI_API_KEY');
      const classified = classifyNarrationError(authError);

      expect(classified.code).toBe('AUTH_CONFIG_ERROR');
      expect(classified.category).toBe('config');
      expect(classified.retryable).toBe(false);
    });
  });

  describe('Upstream Transient Errors (5xx)', () => {
    it('classifies 503 Service Unavailable as retryable transient error', () => {
      const transientError = {
        status: 503,
        message: 'The model is overloaded. Please try again later.',
      };

      const classified = classifyNarrationError(transientError);
      expect(classified.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(classified.category).toBe('transient');
      expect(classified.retryable).toBe(true);
    });

    it('classifies network connection drops (ECONNRESET) as retryable', () => {
      const netError = new Error('fetch failed: read ECONNRESET');
      const classified = classifyNarrationError(netError);

      expect(classified.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(classified.category).toBe('transient');
      expect(classified.retryable).toBe(true);
    });
  });

  describe('Fallback Generic Handling', () => {
    it('gracefully falls back to system error for unknown exceptions', () => {
      const unknownError = new Error('Something completely unexpected occurred');
      const classified = classifyNarrationError(unknownError);

      expect(classified.code).toBe('INTERNAL_ERROR');
      expect(classified.category).toBe('system');
      expect(classified.retryable).toBe(false);
    });
  });
});
