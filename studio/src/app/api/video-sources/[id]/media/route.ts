import {verifyIdToken} from '@/lib/firebase-admin';
import {readSourcePreview} from '@/lib/video-source-server';
import {VideoRequestError} from '@/lib/video-generation';
export const runtime = 'nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  const uid = await verifyIdToken(request.headers.get('authorization'));
  if (!uid) return Response.json({message:'Please sign in to view this reference.'},{status:401});
  try {
    const {bytes} = await readSourcePreview(uid,(await params).id);
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'video/mp4','Cache-Control':'private, no-store'}});
  } catch(error) {return Response.json({message:error instanceof VideoRequestError ? error.message : 'Reference preview could not be loaded.'},{status:error instanceof VideoRequestError ? error.status : 503});}
}
