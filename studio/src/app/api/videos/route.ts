import { after } from 'next/server';
import { createGeminiClient } from 'mdmedia/tts';
import { GeminiOmniVideoProvider } from 'mdmedia/video';
import { verifyIdToken } from '@/lib/firebase-admin';
import { claimVideoJob, saveVideoBytes, updateVideoJob } from '@/lib/video-server';
import { runVideoJob } from '@/lib/video-job-runner';
import { parseVideoRequest, readVideoForm, VideoRequestError, VIDEO_MODEL } from '@/lib/video-generation';

export const runtime = 'nodejs';
export const maxDuration = 900;

export async function POST(request: Request): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get('authorization'));
  if (!uid) return Response.json({ message: 'Please sign in to generate a video.' }, { status: 401 });
  if (!process.env.GEMINI_API_KEY) return Response.json({ message: 'Video generation is unavailable. Configure GEMINI_API_KEY on the server.' }, { status: 503 });
  try {
    const parsed = await parseVideoRequest(await readVideoForm(request));
    const model = process.env.GEMINI_VIDEO_MODEL?.trim() || VIDEO_MODEL;
    const { job, created } = await claimVideoJob(uid, parsed, model);
    if (created) {
      // Next keeps this work alive after the response and when the browser changes tabs.
      after(() => runVideoJob(parsed, {
        provider: new GeminiOmniVideoProvider(createGeminiClient(), 0, model),
        update: patch => updateVideoJob(uid, parsed.id, patch),
        save: bytes => saveVideoBytes(uid, parsed.id, bytes),
      }));
    }
    return Response.json({ job }, { status: created ? 202 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof VideoRequestError) return Response.json({ message: error.message }, { status: error.status });
    console.error('[videos] submission failed:', error instanceof Error ? error.message : error);
    return Response.json({ message: 'Could not start video generation. Try again.' }, { status: 503 });
  }
}

export async function GET(request:Request):Promise<Response>{
 const uid=await verifyIdToken(request.headers.get('authorization'));
 if(!uid)return Response.json({message:'Please sign in to view your videos.'},{status:401});
 try{
  const {adminDb}=await import('@/lib/firebase-admin');const {loadVideoJob}=await import('@/lib/video-server');
  const snapshot=await adminDb().collection('videos').doc(uid).collection('clips').orderBy('createdAt','desc').limit(100).get();
  const jobs=await Promise.all(snapshot.docs.map(doc=>loadVideoJob(uid,doc.id)));
  return Response.json({jobs:jobs.filter(Boolean)},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({message:'Video activity could not be loaded.'},{status:503});}
}
