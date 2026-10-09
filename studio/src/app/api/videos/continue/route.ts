import { after } from 'next/server';
import { createGeminiClient } from 'mdmedia/tts';
import { GeminiOmniVideoProvider } from 'mdmedia/video';
import { verifyIdToken } from '@/lib/firebase-admin';
import { claimBeatContinuation, updateVideoJob, saveVideoBytes } from '@/lib/video-server';
import { parseBeatContinuation } from '@/lib/beat-continuation';
import { runVideoJob } from '@/lib/video-job-runner';
import { VideoRequestError, readVideoJson, readVideoForm, parseVideoRequest } from '@/lib/video-generation';

export const runtime='nodejs';
export const maxDuration=900;
export async function POST(request:Request):Promise<Response> {
  const uid=await verifyIdToken(request.headers.get('authorization'));
  if(!uid)return Response.json({message:'Please sign in to continue a beat.'},{status:401});
  if(!process.env.GEMINI_API_KEY)return Response.json({message:'Video generation is unavailable.'},{status:503});
  try {
    let references: File[]=[];
    let input;
    if(request.headers.get('content-type')?.includes('multipart/form-data')) {
      const form=await readVideoForm(request);
      const validated=await parseVideoRequest(form);
      if(validated.firstFrame)throw new VideoRequestError('Continuations use the previous video ending, not a new first frame.');
      references=validated.references;
      input=parseBeatContinuation({id:validated.id,draft:validated.draft,sourceVideoId:form.get('sourceVideoId'),sourceEndSeconds:Number(form.get('sourceEndSeconds'))});
    }else input=parseBeatContinuation(await readVideoJson(request));
    const result=await claimBeatContinuation(uid,input);
    if(result.request){
      const continuation={...result.request,references};
      after(()=>runVideoJob(continuation,{
        provider:new GeminiOmniVideoProvider(createGeminiClient(),0,result.job.model),
        update:patch=>updateVideoJob(uid,input.id,patch),save:bytes=>saveVideoBytes(uid,input.id,bytes),
      }));
    }
    return Response.json({job:result.job},{status:result.request?202:200,headers:{'Cache-Control':'no-store'}});
  }catch(error){
    if(error instanceof VideoRequestError)return Response.json({message:error.message},{status:error.status});
    console.error('[video continuation] submission failed:',error instanceof Error?error.message:error);
    return Response.json({message:'Could not start this continuation. Check its status before retrying.'},{status:503});
  }
}
