import fs from 'node:fs';
import { StudioApiError, StudioClient, type StudioMediaType } from '../remote/client.js';
import { readCredentials } from '../remote/credentials.js';

export function connectedClient(): StudioClient {
  const credentials = readCredentials();
  if (!credentials) throw new StudioApiError(401, 'not_logged_in', 'Not connected to a studio. Run `mdmedia studio login`.');
  return new StudioClient(credentials.url, credentials.apiKey);
}

/**
 * A failure after a media item was created. The item exists and may still
 * finish, so the error names it: retrying would start, and pay for, another.
 */
export class StartedMediaError extends Error {
  constructor(readonly cause: unknown, readonly item: { id: string; type: StudioMediaType; links: { web: string } }) {
    super(`${cause instanceof Error ? cause.message : String(cause)} It was created and may still finish; check with \`mdmedia studio status ${item.id} --type ${item.type}\` instead of running it again.`);
    this.name = 'StartedMediaError';
  }
}

/**
 * Errors print as one line; `--json` callers get `{ error: { code, message } }` on stdout,
 * plus the item's `id`, `type`, and `links` when it was already created.
 */
export async function guarded(json: boolean | undefined, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const started = error instanceof StartedMediaError ? error : null;
    const cause = started ? started.cause : error;
    const code = cause instanceof StudioApiError ? cause.code : 'error';
    let message = error instanceof Error ? error.message : String(error);
    // Keys approved before a medium existed lack its scopes; a new login approves them.
    if (code === 'insufficient_scope') message = `${message} Run \`mdmedia studio login\` again to approve this access.`;
    if (json) console.log(JSON.stringify({ error: { code, message }, ...(started ? started.item : {}) }));
    else console.error(`mdmedia studio: ${message}`);
    process.exitCode = 1;
  }
}

/**
 * Text from an inline flag, `--input <file>` (`-` for stdin), or piped stdin.
 * `inline` names the flag and what the text is, for the messages.
 */
export async function readSource(input: string | undefined, text: string | undefined, inline: { flag: string; what: string }): Promise<string> {
  if (text !== undefined && input !== undefined) throw new Error(`Pass either --input or ${inline.flag}, not both.`);
  if (text !== undefined) return text;
  if (input === '-' || (input === undefined && !process.stdin.isTTY)) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (input === undefined) throw new Error(`Pass --input <file>, ${inline.flag} "…", or pipe ${inline.what} on stdin.`);
  return fs.promises.readFile(input, 'utf8');
}
