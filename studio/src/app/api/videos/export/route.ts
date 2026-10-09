import {audioObjectPath,readStorageObjectBytes} from '@/lib/narration-server';
import { after } from 'next/server';
import { verifyIdToken } from '@/lib/firebase-admin';
import { readVideoJson, VideoRequestError } from '@/lib/video-generation';
import { parseVideoExport } from '@/lib/video-export';
import { claimVideoExport } from '@/lib/video-export-server';
import { checkVideoEncoder, runVideoExport } from '@/lib/video-export-runner';
import { readVideoBytes, saveVideoBytes, updateVideoJob } from '@/lib/video-server';

export const runtime='nodejs';
export const maxDuration=900;
export async function POST(request:Request):Promise<Response> {
  const uid=await verifyIdToken(request.headers.get('authorization'));
  if(!uid)return Response.json({message:'Please sign in to export this scene.'},{status:401});
  try {
    const parsed=parseVideoExport(await readVideoJson(request));
    await checkVideoEncoder();
    const {job,created}=await claimVideoExport(uid,parsed);
    if(created)after(()=>runVideoExport(parsed,{read:id=>readVideoBytes(uid,id),readAudio:async id=>{const bytes=await readStorageObjectBytes(audioObjectPath(uid,id));if(!bytes)throw new Error('Audio source unavailable');return bytes;},save:bytes=>saveVideoBytes(uid,parsed.id,bytes),update:patch=>updateVideoJob(uid,parsed.id,patch)}));
    return Response.json({job},{status:created?202:200,headers:{'Cache-Control':'no-store'}});
  }catch(error){
    if(error instanceof VideoRequestError)return Response.json({message:error.message},{status:error.status});
    console.error('[video export] submission failed:',error instanceof Error?error.message:error);
    return Response.json({message:'Video export is unavailable. Check its status before retrying.'},{status:503});
  }
}
