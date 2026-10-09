import {adminDb,verifyIdToken} from '@/lib/firebase-admin';
import {loadVideoSource} from '@/lib/video-source-server';
import {isVideoId,readVideoJson,VideoRequestError,type VideoJob} from '@/lib/video-generation';
import {isSourceId} from '@/lib/video-script';
export const runtime='nodejs';
export async function POST(request:Request){
 const uid=await verifyIdToken(request.headers.get('authorization'));
 if(!uid)return Response.json({message:'Please sign in to attach footage.'},{status:401});
 try{
  const value=await readVideoJson(request) as Record<string,unknown>;
  if(!value||!isVideoId(String(value.id))||!isSourceId(value.sourceId)||!['16:9','9:16'].includes(String(value.frame)))throw new VideoRequestError('Choose a valid recording and frame.');
  const source=await loadVideoSource(uid,value.sourceId);
  if(!source)throw new VideoRequestError('That recording is unavailable in your account.',404);
  const ref=adminDb().collection('videos').doc(uid).collection('clips').doc(String(value.id));
  const job=await adminDb().runTransaction(async transaction=>{
   const existing=(await transaction.get(ref)).data();
   if(existing){if(existing.ownerUid!==uid||existing.sourceAssetId!==source.id||existing.frame!==value.frame)throw new VideoRequestError('That request belongs to another clip.',409);return existing;}
   const now=Date.now();const created:VideoJob={id:String(value.id),status:'ready',model:'uploaded-video',mode:'text',frame:value.frame as VideoJob['frame'],sourceAssetId:source.id,durationSeconds:source.durationSeconds,createdAt:now,updatedAt:now};
   transaction.set(ref,{...created,ownerUid:uid});return created;
  });
  return Response.json({job:{id:job.id,status:job.status,model:job.model,mode:job.mode,frame:job.frame,sourceAssetId:source.id,durationSeconds:job.durationSeconds,createdAt:job.createdAt,updatedAt:job.updatedAt}},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return Response.json({message:error instanceof VideoRequestError?error.message:'Recording could not be attached. Try again.'},{status:error instanceof VideoRequestError?error.status:503});}
}
