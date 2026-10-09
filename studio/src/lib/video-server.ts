import {readSourcePreview} from './video-source-server';
import {isSourceId} from './video-script';
import {readAudioPlacements} from './audio-placement';
import { adminDb, adminBucket } from './firebase-admin';
import { isVideoId, VIDEO_TIMEOUT_MS, VideoRequestError, type VideoJob, type VideoRequest } from './video-generation';
import { sceneDuration, planSceneGeneration } from './scene-generation-plan';
import { readSceneDraft } from './scene-direction';
import { continuationRequest, type BeatContinuationInput } from './beat-continuation';

const videoRef = (uid: string, id: string) => adminDb().collection('videos').doc(uid).collection('clips').doc(id);
export const videoObjectPath = (uid: string, id: string) => `videos/${uid}/${id}.mp4`;

/** A caller-generated request id makes a lost POST response safe to retry. */
export async function claimVideoJob(uid: string, request: VideoRequest, model: string): Promise<{ job: VideoJob; created: boolean }> {
  const ref = videoRef(uid, request.id);
  return adminDb().runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return { job: publicVideoJob(request.id, existing.data()!), created: false };
    const now = Date.now();
    const job: VideoJob = { id: request.id, model, direction: request.draft, mode: request.draft.mode, frame: request.draft.frame, status: 'generating', createdAt: now, updatedAt: now };
    const duration = sceneDuration(request.draft);
    if (duration !== undefined) job.requestedDurationSeconds = duration;
    // The preceding transactional read guarantees this is a new id. `set` also
    // works in the local Pyric Admin adapter, which does not expose `create`.
    transaction.set(ref, { ...job, ownerUid: uid, direction: request.draft, prompt: request.prompt });
    return { job, created: true };
  });
}

function publicVideoJob(id: string, data: Record<string, unknown>): VideoJob {
  const draft = readSceneDraft({ version: 1, draft: data.direction });
  const requested = typeof data.requestedDurationSeconds === 'number' ? data.requestedDurationSeconds : draft ? sceneDuration(draft) : undefined;
  const savedContinuation=data.continuation as VideoJob['continuation'];
  const continuation=savedContinuation && isVideoId(savedContinuation.sourceVideoId) && Number.isFinite(savedContinuation.startSeconds) && savedContinuation.startSeconds>0 ? {sourceVideoId:savedContinuation.sourceVideoId,startSeconds:savedContinuation.startSeconds}:undefined;
  return {
    ...(isSourceId(data.sourceAssetId)?{sourceAssetId:data.sourceAssetId}:{}),
    id, status: data.status as VideoJob['status'], model: String(data.model), mode: data.mode as VideoJob['mode'], frame: data.frame as VideoJob['frame'],
    createdAt: Number(data.createdAt), updatedAt: Number(data.updatedAt),
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
    ...(typeof data.durationSeconds === 'number' ? { durationSeconds: data.durationSeconds } : {}),
    ...(requested !== undefined ? { requestedDurationSeconds: requested } : {}),
    ...(draft ? { direction: draft } : {}),
    ...(Array.isArray(data.exportCaptions)?{exportCaptions:data.exportCaptions as VideoJob['exportCaptions']}:{}),
    ...(Array.isArray(data.exportInputs) ? { exportInputs: data.exportInputs as VideoJob['exportInputs'] } : {}),
    ...(continuation?{continuation}:{}),
    ...(Array.isArray(data.exportAudio)?{exportAudio:readAudioPlacements(data.exportAudio)}:{}),
    canExtend:data.status==='ready'&&typeof data.interactionId==='string'&&!!data.interactionId&&data.model!=='local-export',
    ...(draft && data.status === 'partial' && typeof data.interactionId === 'string' && typeof data.durationSeconds === 'number' ? {canContinue: planSceneGeneration(draft).slice(0,-1).some(step => Math.abs((continuation?.startSeconds??0)+step.end - Number(data.durationSeconds)) <= 0.25)} : {}),
  };
}

export async function claimBeatContinuation(uid:string,input:BeatContinuationInput):Promise<{job:VideoJob;request?:VideoRequest}> {
  return adminDb().runTransaction(async transaction=>{
    const ref=videoRef(uid,input.id), existing=await transaction.get(ref);
    if(existing.exists){
      const data=existing.data()!;
      if(data.ownerUid!==uid)throw new VideoRequestError('That video is unavailable.',404);
      const job=publicVideoJob(input.id,data);
      if(job.continuation?.sourceVideoId!==input.sourceVideoId||Math.abs(job.continuation.startSeconds-input.sourceEndSeconds)>0.001||JSON.stringify(job.direction)!==JSON.stringify(input.draft))throw new VideoRequestError('That request id belongs to another generation.',409);
      return {job};
    }
    const snapshot=await transaction.get(videoRef(uid,input.sourceVideoId)), data=snapshot.data();
    if(!data||data.ownerUid!==uid)throw new VideoRequestError('The previous beat is unavailable in your account.',404);
    const source=publicVideoJob(input.sourceVideoId,data);
    const request=continuationRequest(input,source,data.interactionId);
    const now=Date.now();
    const job:VideoJob={id:input.id,status:'generating',model:source.model,mode:input.draft.mode,frame:input.draft.frame,direction:input.draft,createdAt:now,updatedAt:now,requestedDurationSeconds:request.continuation!.startSeconds+sceneDuration(input.draft)!,continuation:{sourceVideoId:input.sourceVideoId,startSeconds:request.continuation!.startSeconds},message:'Continuing the previous beat'};
    transaction.set(ref,{...job,ownerUid:uid,prompt:request.prompt});
    return {job,request};
  });
}

export async function loadVideoJob(uid: string, id: string): Promise<VideoJob | null> {
  if (!isVideoId(id)) return null;
  const ref = videoRef(uid, id);
  return adminDb().runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.ownerUid !== uid) return null;
    const job = publicVideoJob(id, snapshot.data()!);
    if ((job.status === 'generating' || job.status === 'saving') && Date.now() - job.updatedAt > VIDEO_TIMEOUT_MS + 60000) {
      const patch = { status: job.durationSeconds ? 'partial' as const : 'error' as const, message: 'Generation was interrupted or took too long. Your direction is saved; try again.', updatedAt: Date.now() };
      transaction.update(ref, patch);
      return { ...job, ...patch };
    }
    return job;
  });
}

/** Claim only a saved section boundary. Concurrent resume calls cannot duplicate a paid turn. */
export async function claimVideoContinuation(uid: string, id: string, submitted: unknown): Promise<{ job: VideoJob; request?: VideoRequest }> {
  if (!isVideoId(id)) throw new VideoRequestError('That video is unavailable.', 404);
  const ref = videoRef(uid, id);
  return adminDb().runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data();
    if (!data || data.ownerUid !== uid) throw new VideoRequestError('That video is unavailable.', 404);
    const job = publicVideoJob(id, data);
    if (job.status === 'generating' || job.status === 'saving') return { job };
    const draft = readSceneDraft({version:1,draft:data.direction});
    const current = readSceneDraft({version:1,draft:submitted});
    if (!draft || !current || JSON.stringify(draft) !== JSON.stringify(current)) throw new VideoRequestError('Direction has changed. Generate a new scene to use your edits.', 409);
    if (job.status !== 'partial' || typeof data.interactionId !== 'string' || typeof job.durationSeconds !== 'number' ||
        !planSceneGeneration(draft).slice(0,-1).some(step => Math.abs((job.continuation?.startSeconds??0)+step.end-job.durationSeconds!) <= 0.25)) throw new VideoRequestError('This result cannot be continued. Generate the full scene again.', 409);
    const next: VideoJob = { ...job, status:'generating', message:'Continuing the saved scene', updatedAt:Date.now() };
    transaction.update(ref, {status:next.status,message:next.message,updatedAt:next.updatedAt});
    return {job:next,request:{id,draft,prompt:String(data.prompt),firstFrame:null,references:[],resume:{interactionId:data.interactionId,durationSeconds:job.durationSeconds},...(job.continuation?{continuation:job.continuation}:{})}};
  });
}

export const updateVideoJob = (uid: string, id: string, patch: Partial<VideoJob> & { interactionId?: string }) => videoRef(uid, id).update(patch).then(() => undefined);
export const saveVideoBytes = (uid: string, id: string, bytes: Uint8Array) => adminBucket().file(videoObjectPath(uid, id)).save(Buffer.from(bytes), { contentType: 'video/mp4', resumable: false }).then(() => undefined);
export async function readVideoBytes(uid: string, id: string): Promise<Buffer> {
  const record=(await videoRef(uid,id).get()).data();
  if(!record||record.ownerUid!==uid)throw new VideoRequestError('That clip is unavailable.',404);
  if(record.model==='uploaded-video'&&isSourceId(record.sourceAssetId))return (await readSourcePreview(uid,record.sourceAssetId)).bytes;
  const [bytes] = await adminBucket().file(videoObjectPath(uid, id)).download();
  return bytes;
}
