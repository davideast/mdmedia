import { StudioApiError, StudioClient } from '../remote/client.js';
import { readCredentials } from '../remote/credentials.js';

export function connectedClient(): StudioClient {
  const credentials = readCredentials();
  if (!credentials) throw new StudioApiError(401, 'not_logged_in', 'Not connected to a studio. Run `mdmedia studio login`.');
  return new StudioClient(credentials.url, credentials.apiKey);
}

/** Errors print as one line; `--json` callers get `{ error: { code, message } }` on stdout. */
export async function guarded(json: boolean | undefined, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const code = error instanceof StudioApiError ? error.code : 'error';
    let message = error instanceof Error ? error.message : String(error);
    // Keys approved before a medium existed lack its scopes; a new login approves them.
    if (code === 'insufficient_scope') message = `${message} Run \`mdmedia studio login\` again to approve this access.`;
    if (json) console.log(JSON.stringify({ error: { code, message } }));
    else console.error(`mdmedia studio: ${message}`);
    process.exitCode = 1;
  }
}
