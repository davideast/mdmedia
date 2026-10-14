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
