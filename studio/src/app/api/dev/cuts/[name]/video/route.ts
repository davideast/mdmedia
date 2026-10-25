import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { loadCut, mediaFileInsideRoot, parseByteRange } from '@/lib/cut-files-server';

export const runtime = 'nodejs';

/**
 * Development only: streams a cut's rendered video with byte-range support.
 * It serves the one file the cut names as its `output`, and only from inside
 * the media root; no path comes from the request.
 */
async function serve(request: Request, params: Promise<{ name: string }>, head: boolean): Promise<Response> {
  const { name } = await params;
  const cut = await loadCut(name);
  if (!cut.ok) return Response.json({ message: cut.message }, { status: cut.status });
  const file = cut.timeline.output ? await mediaFileInsideRoot(cut.timeline.output) : null;
  if (!file) return Response.json({ message: 'This cut has no rendered video in the media folder.' }, { status: 404 });

  const etag = `"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': new Date(file.mtimeMs).toUTCString(),
  });
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });

  // A stale If-Range means the file changed under the player: send it whole.
  const ifRange = request.headers.get('if-range');
  const range = ifRange && ifRange !== etag ? null : parseByteRange(request.headers.get('range'), file.size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  headers.set('Content-Length', String(end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
  const status = range ? 206 : 200;
  if (head) return new Response(null, { status, headers });

  const body = Readable.toWeb(createReadStream(file.path, { start, end })) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

export function GET(request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  return serve(request, params, false);
}

export function HEAD(request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  return serve(request, params, true);
}
