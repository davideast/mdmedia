import type {SceneDraftRecord} from '@/lib/video-generation';
import {authenticatedVideoFetch} from './use-video-jobs';
export async function saveVideoPlan(id:string,record:SceneDraftRecord){
  if(!record.videoBrief)return;
  await authenticatedVideoFetch(`/api/video-plans/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoBrief:record.videoBrief,builtScript:record.builtScript,draft:record.draft,beatClips:record.beatClips,exportId:record.exportId})});
}
