/** Next's request URL can carry an internal hostname behind a reverse proxy. */
export function apiOrigin(request: Request, configured = process.env.MDMEDIA_PUBLIC_ORIGIN): string {
  if (!configured) return new URL(request.url).origin;
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MDMEDIA_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, a path, query, or fragment.');
  }
  return url.origin;
}
