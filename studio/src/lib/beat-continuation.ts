import { readSceneDraft, serializeSceneDirection, type SceneDraft } from './scene-direction';
import { sceneDuration, planSceneGeneration, MAX_SCENE_SECONDS } from './scene-generation-plan';
import { isVideoId, VideoRequestError, type VideoJob, type VideoRequest } from './video-generation';

export interface BeatContinuationInput { id:string; sourceVideoId:string; sourceEndSeconds:number; draft:SceneDraft }
export function parseBeatContinuation(value:unknown):BeatContinuationInput {
  if (!value || typeof value!=='object') throw new VideoRequestError('Choose a previous beat to continue.');
  const data=value as Record<string,unknown>;
  if(typeof data.id!=='string'||!isVideoId(data.id)||typeof data.sourceVideoId!=='string'||!isVideoId(data.sourceVideoId)||data.id===data.sourceVideoId) throw new VideoRequestError('The continuation request is invalid.');
  if(typeof data.sourceEndSeconds!=='number'||!Number.isFinite(data.sourceEndSeconds)||data.sourceEndSeconds<=0) throw new VideoRequestError('The previous ending is invalid.');
  const draft=readSceneDraft({version:1,draft:data.draft});
  if(!draft||draft.beats.length!==1||!draft.beats[0].text.trim()||draft.beats[0].start!==0||draft.beats[0].end===null||draft.beats[0].end<3) throw new VideoRequestError('A continuation beat must start at 0 and last at least 3 seconds.');
  if(serializeSceneDirection(draft).length>20000)throw new VideoRequestError('Keep scene direction under 20,000 characters.');
  try{planSceneGeneration(draft);}catch(error){throw new VideoRequestError(error instanceof Error?error.message:'The beat timing is invalid.');}
  return {id:data.id,sourceVideoId:data.sourceVideoId,sourceEndSeconds:data.sourceEndSeconds,draft};
}

/** The server resolves the private interaction; the browser never supplies one. */
export function continuationRequest(input:BeatContinuationInput, source:VideoJob, interactionId:unknown):VideoRequest {
  if(source.status!=='ready')throw new VideoRequestError('Wait for the previous beat to finish before continuing.',409);
  if(typeof interactionId!=='string'||!interactionId||source.model==='local-export')throw new VideoRequestError('This source cannot be continued. Choose New shot.',409);
  if(source.frame!==input.draft.frame)throw new VideoRequestError('Keep the same frame when continuing a beat.',409);
  if(typeof source.durationSeconds!=='number'||Math.abs(input.sourceEndSeconds-source.durationSeconds)>0.001)throw new VideoRequestError('Restore the previous beat’s original ending before continuing. Trimmed endings are not supported yet.',409);
  if(source.durationSeconds+sceneDuration(input.draft)!>MAX_SCENE_SECONDS+0.25)throw new VideoRequestError('A connected shot can be up to 40 seconds. Start a new shot for this beat.');
  return {id:input.id,draft:input.draft,prompt:serializeSceneDirection(input.draft),firstFrame:null,references:[],continuation:{sourceVideoId:input.sourceVideoId,startSeconds:source.durationSeconds,interactionId}};
}
