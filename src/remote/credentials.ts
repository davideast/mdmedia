import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the connected-studio key lives. One file, readable only by you:
 * `$XDG_CONFIG_HOME/mdmedia/credentials.json` (default `~/.config/mdmedia`).
 * `MDMEDIA_API_KEY` and `MDMEDIA_STUDIO_URL` override it, for CI.
 */
export interface StudioCredentials {
  url: string;
  apiKey: string;
  keyId?: string;
  name?: string;
  createdAt?: number;
}

export const DEFAULT_STUDIO_URL = 'http://localhost:3000';

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'mdmedia', 'credentials.json');
}

export class InsecureCredentialsError extends Error {
  constructor(file: string) {
    super(`${file} is readable by other users. Run: chmod 600 "${file}"`);
    this.name = 'InsecureCredentialsError';
  }
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env, file = credentialsPath(env)): StudioCredentials | null {
  if (env.MDMEDIA_API_KEY) {
    return { url: env.MDMEDIA_STUDIO_URL || DEFAULT_STUDIO_URL, apiKey: env.MDMEDIA_API_KEY };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  // A key others can read is a key others can use. Refuse it rather than use it.
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new InsecureCredentialsError(file);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StudioCredentials>;
  if (typeof parsed.apiKey !== 'string' || typeof parsed.url !== 'string') return null;
  return { ...parsed, url: env.MDMEDIA_STUDIO_URL || parsed.url } as StudioCredentials;
}

/** Writes atomically with owner-only permissions from the first byte. */
export function writeCredentials(credentials: StudioCredentials, file = credentialsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

export function deleteCredentials(file = credentialsPath()): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
