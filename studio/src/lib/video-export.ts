import {readAudioPlacements,type AudioPlacement} from './audio-placement';
import { isVideoId, VideoRequestError, type VideoExportClip } from './video-generation';
import type { SceneFrame } from './scene-direction';

export const MAX_EXPORT_CLIPS = 32;
export const MAX_EXPORT_SECONDS = 300;
export interface VideoExportRequest { id: string; frame: SceneFrame; clips: VideoExportClip[]; audio?:AudioPlacement[]; captions?:{text:string;start:number;end:number}[] }
export function parseVideoExport(value: unknown): VideoExportRequest {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !isVideoId(value.id) ||
      !('frame' in value) || value.frame !== '16:9' && value.frame !== '9:16' || !('clips' in value) || !Array.isArray(value.clips) || !value.clips.length || value.clips.length > MAX_EXPORT_CLIPS) {
    throw new VideoRequestError(`Choose between 1 and ${MAX_EXPORT_CLIPS} beat clips to export.`);
  }
  const clips: VideoExportClip[] = value.clips.map(clip => {
    if (!clip || typeof clip !== 'object' || typeof clip.videoId !== 'string' || !isVideoId(clip.videoId) || typeof clip.inSeconds !== 'number' || !Number.isFinite(clip.inSeconds) || clip.inSeconds < 0 ||
        typeof clip.outSeconds !== 'number' || !Number.isFinite(clip.outSeconds) || clip.outSeconds - clip.inSeconds < 0.05 || typeof clip.muted !== 'boolean') throw new VideoRequestError('Each clip needs a valid source and trim range.');
    if (clip.transition!==undefined&&clip.transition!=='cut'&&clip.transition!=='fade') throw new VideoRequestError('Choose a hard cut or fade transition.');
    if(clip.transition==='fade'&&(typeof clip.transitionSeconds!=='number'||!Number.isFinite(clip.transitionSeconds)||clip.transitionSeconds<=0))throw new VideoRequestError('Choose a valid fade length.');
    return {videoId:clip.videoId,inSeconds:clip.inSeconds,outSeconds:clip.outSeconds,muted:clip.muted,transition:clip.transition==='fade'?'fade':'cut',transitionSeconds:clip.transition==='fade'?clip.transitionSeconds:0};
  });
  clips.forEach((clip,index)=>{
    const next=clips[index+1];
    const fadeSeconds=clip.transitionSeconds??0;
    if(clip.transition==='fade'&&(!next||fadeSeconds>Math.min(clip.outSeconds-clip.inSeconds,next.outSeconds-next.inSeconds)/2))throw new VideoRequestError('A fade must fit within half of each adjacent clip.');
  });
  if (exportDuration(clips) > MAX_EXPORT_SECONDS) throw new VideoRequestError(`An export can be up to ${MAX_EXPORT_SECONDS} seconds.`);
  const rawAudio='audio' in value?value.audio:[];
  const audio=readAudioPlacements(rawAudio);
  if(!Array.isArray(rawAudio)||audio.length!==rawAudio.length)throw new VideoRequestError('Choose valid audio placements, up to 32 per export.');
  if(audio.some(clip=>clip.startSeconds>=exportDuration(clips)))throw new VideoRequestError('Place each audio clip before the end of the video.');
  const rawCaptions='captions' in value?value.captions:[];
  if(!Array.isArray(rawCaptions)||rawCaptions.length>32)throw new VideoRequestError('Use up to 32 editorial captions.');
  const captions=rawCaptions.map(caption=>{
    if(!caption||typeof caption.text!=='string'||!caption.text.trim()||caption.text.length>160||typeof caption.start!=='number'||typeof caption.end!=='number'||!Number.isFinite(caption.start)||!Number.isFinite(caption.end)||caption.start<0||caption.end<=caption.start||caption.end>exportDuration(clips))throw new VideoRequestError('Caption timing must fit inside the video.');
    return {text:caption.text,start:caption.start,end:caption.end};
  });
  return {id:value.id,frame:value.frame,clips,...(audio.length?{audio}:{}),...(captions.length?{captions}:{})};
}
export const exportDuration=(clips:VideoExportClip[])=>clips.reduce((sum,clip,index)=>sum+clip.outSeconds-clip.inSeconds-(index<clips.length-1&&clip.transition==='fade'?(clip.transitionSeconds??0):0),0);

/** Adjacent windows of one shot are encoded once, preserving motion across beat boundaries. */
export function coalesceContinuousRanges(clips:VideoExportClip[]):VideoExportClip[] {
  const result:VideoExportClip[]=[];
  for(const clip of clips){
    const previous=result.at(-1);
    if(previous&&previous.videoId===clip.videoId&&previous.muted===clip.muted&&previous.transition!=='fade'&&Math.abs(previous.outSeconds-clip.inSeconds)<0.000001){
      previous.outSeconds=clip.outSeconds;previous.transition=clip.transition;previous.transitionSeconds=clip.transitionSeconds;
    }else result.push({...clip});
  }
  return result;
}
