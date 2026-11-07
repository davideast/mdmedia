/**
 * Browser-and-server-safe `/slash` command catalog and input matching helpers.
 */

import type { SlashCommandId } from './types';

export interface SlashCommandEntry {
  command: SlashCommandId;
  /** Bound server tool name, or `null` for client-only commands (`/new`). */
  toolName: string | null;
  /** Short verb phrase displayed in `ChatSlashPopover`. */
  summary: string;
  /** Placeholder shown in `<textarea>` while the command chip is bound. */
  argumentHint: string;
  /**
   * Tool choice pinning behavior on Step 0 of the Gemini Interactions turn:
   * - `'single'`: force `allowed_tools: { mode: 'any', tools: [toolName] }`
   * - `'context-then-tool'`: allow context readers + target tool on Step 0
   * - `'auto'`: keep `tool_choice: 'auto'` with system prompt hint
   */
  pinMode: 'single' | 'context-then-tool' | 'auto' | 'client-only';
}

export const CHAT_SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  {
    command: 'analyze',
    toolName: 'analyze_video',
    summary: 'Analyze a video, clip, or YouTube link',
    argumentHint: 'What should Studio look for in this video?',
    pinMode: 'single',
  },
  {
    command: 'narrate',
    toolName: 'create_narration',
    summary: 'Synthesize audio narration from text or active doc',
    argumentHint: 'Describe what to narrate, or say "narrate this doc"…',
    pinMode: 'context-then-tool',
  },
  {
    command: 'image',
    toolName: 'generate_image',
    summary: 'Generate an image in Studio',
    argumentHint: 'Describe the image to generate…',
    pinMode: 'single',
  },
  {
    command: 'video',
    toolName: 'generate_video',
    summary: 'Generate a video clip in Studio',
    argumentHint: 'Describe the shot or motion…',
    pinMode: 'single',
  },
  {
    command: 'music',
    toolName: 'generate_music',
    summary: 'Generate music or an instrumental cue',
    argumentHint: 'Describe mood, tempo, instruments, or lyrics…',
    pinMode: 'single',
  },
  {
    command: 'doc',
    toolName: 'upsert_tree_document',
    summary: 'Create or update a Markdown tree document',
    argumentHint: 'Create or update a tree document…',
    pinMode: 'context-then-tool',
  },
  {
    command: 'find',
    toolName: 'search_library',
    summary: 'Search videos, narrations, images, music, and analyses',
    argumentHint: 'Search videos, narrations, images, music, analyses…',
    pinMode: 'single',
  },
  {
    command: 'context',
    toolName: 'get_active_view_context',
    summary: 'Inspect what is currently open on screen',
    argumentHint: 'Ask about what is currently open on screen…',
    pinMode: 'single',
  },
  {
    command: 'open',
    toolName: 'open_in_studio',
    summary: 'Open a Library item, route, or tree document',
    argumentHint: 'Item name, media type, or tree document to open…',
    pinMode: 'context-then-tool',
  },
  {
    command: 'new',
    toolName: null,
    summary: 'Start a fresh chat thread',
    argumentHint: 'Press Enter to start a new chat',
    pinMode: 'client-only',
  },
] as const;

const BY_COMMAND = new Map<string, SlashCommandEntry>(
  CHAT_SLASH_COMMANDS.map((entry) => [entry.command, entry]),
);

export function getSlashCommand(command: string | null | undefined): SlashCommandEntry | null {
  if (!command) return null;
  return BY_COMMAND.get(command.toLowerCase()) ?? null;
}

/**
 * Filters `CHAT_SLASH_COMMANDS` when the user types `/<query>` at the start of
 * the composer. Command prefix matches rank ahead of summary keyword matches.
 */
export function filterSlashCommands(query: string): SlashCommandEntry[] {
  const normalized = query.trim().toLowerCase().replace(/^\//, '');
  if (!normalized) return [...CHAT_SLASH_COMMANDS];
  const prefixMatches: SlashCommandEntry[] = [];
  const keywordMatches: SlashCommandEntry[] = [];
  for (const entry of CHAT_SLASH_COMMANDS) {
    if (entry.command.startsWith(normalized)) {
      prefixMatches.push(entry);
    } else if (entry.summary.toLowerCase().includes(normalized)) {
      keywordMatches.push(entry);
    }
  }
  return [...prefixMatches, ...keywordMatches];
}

/**
 * Extracts a leading `/command` token if the user typed `/analyze what happens`
 * directly and pressed Enter without explicitly clicking the popover.
 */
export function extractLeadingSlashCommand(rawText: string): {
  slashCommand: SlashCommandEntry | null;
  remainingText: string;
} {
  const match = /^\/([a-zA-Z-]+)(?:\s+([\s\S]*))?$/.exec(rawText.trim());
  if (!match) return { slashCommand: null, remainingText: rawText };
  const entry = getSlashCommand(match[1]);
  if (!entry) return { slashCommand: null, remainingText: rawText };
  return {
    slashCommand: entry,
    remainingText: (match[2] ?? '').trim(),
  };
}
