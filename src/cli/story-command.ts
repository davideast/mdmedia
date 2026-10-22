import { defineCommand } from 'citty';
import { readFile } from 'node:fs/promises';
import { parseStory } from '../story/index.js';
import type { Diagnostic } from '../story/index.js';

/** One diagnostic per line: `file:line:col severity code message`. */
export function formatDiagnostics(file: string, diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) return `${file}: no problems`;
  return diagnostics
    .map((d) => `${file}:${d.source?.line ?? 1}:${d.source?.column ?? 1} ${d.severity} ${d.code} ${d.message}`)
    .join('\n');
}

/** Parses a story file; resolves to the exit code. */
export async function checkStory(file: string, json: boolean, write: (text: string) => void): Promise<number> {
  let markdown: string;
  try {
    markdown = await readFile(file, 'utf8');
  } catch (error) {
    write(json ? JSON.stringify([{ code: 'unreadable', severity: 'error', message: String(error) }]) : `${file}: cannot read file`);
    return 1;
  }
  const { diagnostics } = await parseStory(markdown, { path: file });
  write(json ? JSON.stringify(diagnostics, null, 2) : formatDiagnostics(file, diagnostics));
  return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

export const storyCheckCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Check a story file and report errors and warnings with their positions',
  },
  args: {
    file: { type: 'positional', description: 'Story markdown file', required: true },
    json: { type: 'boolean', description: 'Print diagnostics as JSON', default: false },
  },
  async run({ args }) {
    process.exitCode = await checkStory(args.file, args.json, (text) => console.log(text));
  },
});

export const storyCommand = defineCommand({
  meta: {
    name: 'story',
    description: 'Build stories into audio dramas and graphic novels',
  },
  subCommands: {
    check: storyCheckCommand,
  },
});
