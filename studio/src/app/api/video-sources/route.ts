import {verifyIdToken} from '@/lib/firebase-admin';
import {readVideoForm, VideoRequestError} from '@/lib/video-generation';
import {saveVideoSource} from '@/lib/video-source-server';
export const runtime = 'nodejs';
export const maxDuration = 120;
export async function POST(request: Request) {
  const uid = await verifyIdToken(request.headers.get('authorization'));
  if (!uid) return Response.json({message:'Please sign in to upload a reference.'},{status:401});
  try {
    const form = await readVideoForm(request), file = form.get('video');
    if (!(file instanceof File)) throw new VideoRequestError('Choose a reference video.');
    return Response.json({source:await saveVideoSource(uid,file)},{status:201,headers:{'Cache-Control':'no-store'}});
  } catch(error) { return Response.json({message:error instanceof VideoRequestError ? error.message : 'Upload could not finish. Try again.'},{status:error instanceof VideoRequestError ? error.status : 503}); }
}
