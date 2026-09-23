/**
 * Narration request parsing, validation, and ID generation.
 *
 * Isomorphic, dependency-free utility module safe for use across browser,
 * server, and CI root test environments without requiring Firebase SDK runtime.
 */

import {
  VOICES,
  type Visibility,
  type VoiceName,
} from './types';

/** The validated body of `POST /api/narrations`. */
export interface NarrationRequest {
  id?: string;
  markdown: string;
  voice: VoiceName;
  promptStyle: string;
  rewriteForNarration: boolean;
  rewriteInstructions?: string;
  structureMarkdown?: boolean;
  visibility: Visibility;
}

const VISIBILITIES: readonly Visibility[] = ['private', 'shared', 'public'];

function isVoice(value: unknown): value is VoiceName {
  return typeof value === 'string' && (VOICES as readonly string[]).includes(value);
}

function isVisibility(value: unknown): value is Visibility {
  return typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value);
}

/** Returns the validated request body, or `null` when it is unusable. */
export function parseNarrationRequest(body: unknown): NarrationRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const markdown = typeof raw.markdown === 'string' ? raw.markdown : '';
  if (markdown.trim().length === 0) return null;
  if (!isVoice(raw.voice)) return null;
  if (!isVisibility(raw.visibility)) return null;

  const RESERVED_IDS = new Set(['narrations', 'new', 'settings', 'playlists', 'queue', 'library']);
  const customId =
    typeof raw.id === 'string' &&
    /^[A-Za-z0-9_-]{10,128}$/.test(raw.id) &&
    !RESERVED_IDS.has(raw.id.toLowerCase())
      ? raw.id
      : undefined;

  return {
    id: customId,
    markdown,
    voice: raw.voice,
    promptStyle: typeof raw.promptStyle === 'string' ? raw.promptStyle : '',
    rewriteForNarration: raw.rewriteForNarration === true,
    rewriteInstructions:
      typeof raw.rewriteInstructions === 'string' && raw.rewriteInstructions.trim().length > 0
        ? raw.rewriteInstructions.trim()
        : undefined,
    structureMarkdown: raw.structureMarkdown === true,
    visibility: raw.visibility,
  };
}

/**
 * Generates a cryptographically random 20-character alphanumeric ID compatible with
 * Firestore document IDs. Avoids depending on SDK auto-id stubs in simulated environments.
 */
export function generateNarrationId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
