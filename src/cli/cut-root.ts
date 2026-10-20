import path from 'node:path';

/** The media root for a cut command: `--root`, else MDMEDIA_CUT_MEDIA_ROOT (as Studio reads it), else the cut's own `media.root`. */
export function cutMediaRootArg(root: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  const chosen = root ?? env.MDMEDIA_CUT_MEDIA_ROOT;
  return chosen === undefined || chosen === '' ? undefined : path.resolve(chosen);
}
