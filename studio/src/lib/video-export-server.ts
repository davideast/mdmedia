import { adminDb } from './firebase-admin';
import { VideoRequestError, type VideoJob } from './video-generation';
import { exportDuration, type VideoExportRequest } from './video-export';

/** All sources are verified in the owner's namespace before an export can be claimed. */
export async function claimVideoExport(uid: string, request: VideoExportRequest): Promise<{job:VideoJob;created:boolean}> {
  const clips = adminDb().collection('videos').doc(uid).collection('clips');
  return adminDb().runTransaction(async transaction => {
    const ref = clips.doc(request.id); const existing = await transaction.get(ref);
    if (existing.exists) {
      if (existing.data()?.ownerUid !== uid) throw new VideoRequestError('That export is unavailable.',404);
      const data = existing.data()!;
      if (data.model !== 'local-export') throw new VideoRequestError('That request id already belongs to a generated clip.',409);
      return {job:{id:request.id,status:data.status,model:data.model,mode:data.mode,frame:data.frame,createdAt:data.createdAt,updatedAt:data.updatedAt,...(data.message ? {message:data.message}:{}),exportInputs:data.exportInputs,...(data.exportAudio ? {exportAudio:data.exportAudio}:{})},created:false};
    }
    for (const clip of request.clips) {
      const snapshot = await transaction.get(clips.doc(clip.videoId)); const source = snapshot.data();
      if (!source || source.ownerUid !== uid) throw new VideoRequestError('A clip is unavailable in your account.',404);
      if (source.status !== 'ready' && source.status !== 'partial') throw new VideoRequestError('Wait for each included clip to finish before exporting.',409);
      if (source.model !== 'uploaded-video' && source.frame !== request.frame) throw new VideoRequestError('Generate all included clips in the same frame before exporting.',409);
      if (typeof source.durationSeconds !== 'number' || clip.outSeconds > source.durationSeconds + 0.025) throw new VideoRequestError('A trim extends beyond its saved clip.',400);
    }
    for(const audio of request.audio??[]){
      const snapshot=await transaction.get(adminDb().collection('narrations').doc(audio.narrationId));const source=snapshot.data();
      if(!source||source.ownerUid!==uid)throw new VideoRequestError('An audio source is unavailable in your account.',404);
      if(source.status!=='ready')throw new VideoRequestError('Wait for the narration to finish.',409);
      if(typeof source.durationMs!=='number'||audio.outSeconds>source.durationMs/1000+.025)throw new VideoRequestError('An audio trim extends beyond its saved take.',400);
    }
    const now = Date.now(); const job:VideoJob = {id:request.id,status:'generating',model:'local-export',mode:'text',frame:request.frame,createdAt:now,updatedAt:now,requestedDurationSeconds:exportDuration(request.clips),exportInputs:request.clips,...(request.captions?.length?{exportCaptions:request.captions}:{}),...(request.audio?.length?{exportAudio:request.audio}:{}),message:'Assembling your beat clips'};
    transaction.set(ref,{...job,ownerUid:uid}); return {job,created:true};
  });
}
