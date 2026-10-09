import { after } from 'next/server';
import { createGeminiClient } from 'mdmedia/tts';
import { GeminiOmniVideoProvider } from 'mdmedia/video';
import { verifyIdToken } from '@/lib/firebase-admin';
import { claimVideoContinuation, updateVideoJob, saveVideoBytes } from '@/lib/video-server';
import { runVideoJob } from '@/lib/video-job-runner';
import { VideoRequestError, readVideoJson } from '@/lib/video-generation';

export const runtime = 'nodejs';
export const maxDuration = 900;
export async function POST(request: Request, { params }: { params: Promise<{id:string}> }): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get('authorization'));
  if (!uid) return Response.json({message:'Please sign in to continue this scene.'},{status:401});
  if (!process.env.GEMINI_API_KEY) return Response.json({message:'Video generation is unavailable.'},{status:503});
  try {
    // No media upload on resume; the saved interaction owns the preceding context.
    const body = await readVideoJson(request);
    const id = (await params).id;
    const result = await claimVideoContinuation(uid,id,body && typeof body === 'object' && 'draft' in body ? body.draft : null);
    if (result.request) {
      const continuation=result.request;
      after(()=>runVideoJob(continuation, {
        provider:new GeminiOmniVideoProvider(createGeminiClient(),0,result.job.model),
        update:patch=>updateVideoJob(uid,id,patch),save:bytes=>saveVideoBytes(uid,id,bytes),
      }));
    }
    return Response.json({job:result.job},{status:result.request?202:200,headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    if(error instanceof VideoRequestError)return Response.json({message:error.message},{status:error.status});
    return Response.json({message:'Could not continue this scene. Check its status before retrying.'},{status:503});
  }
}
