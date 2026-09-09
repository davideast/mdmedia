import { parseArgs } from 'node:util';
import type { VoiceName } from '../types/voice.js';

export interface ListenCommand {
  mode: 'once' | 'auto' | 'off' | 'generate';
  voice?: VoiceName;
  style?: string;
  targetPath?: string;
}

/**
 * Deterministically extracts the user request payload from an Antigravity transcript step
 * using outer boundary slicing (O(n), immune to inner code blocks or regex backtracking).
 */
export function extractUserRequest(rawContent: string): string {
  const startTag = '<USER_REQUEST>';
  const endTag = '</USER_REQUEST>';
  const startIdx = rawContent.indexOf(startTag);
  const endIdx = rawContent.lastIndexOf(endTag);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return rawContent.slice(startIdx + startTag.length, endIdx).trim();
  }
  return rawContent.split('<ADDITIONAL_METADATA>')[0].trim();
}

/**
 * Quote-aware argv tokenizer that preserves quoted strings with spaces.
 */
export function tokenizeArgv(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

/**
 * Parses a /listen slash command using quote-aware tokenization and node:util.parseArgs.
 */
export function parseListenCommand(rawContent: string): ListenCommand | null {
  const cleanText = extractUserRequest(rawContent);
  const argv = tokenizeArgv(cleanText);

  if (argv[0] !== '/listen') return null;

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      voice: { type: 'string', short: 'v' },
      style: { type: 'string', short: 's' },
    },
    allowPositionals: true,
    strict: false,
  });

  const sub = positionals[0]?.toLowerCase();
  const mode =
    sub === 'auto'
      ? 'auto'
      : sub === 'off' || sub === 'stop'
        ? 'off'
        : sub === 'generate'
          ? 'generate'
          : 'once';

  const targetPath = sub === 'generate' ? positionals[1] : undefined;

  return {
    mode,
    voice: typeof values.voice === 'string' ? (values.voice as VoiceName) : undefined,
    style: typeof values.style === 'string' ? values.style : undefined,
    targetPath,
  };
}
