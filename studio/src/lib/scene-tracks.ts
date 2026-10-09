import { readSceneDraft, type SceneBeat, type SceneDraft } from './scene-direction';
import { type VideoJob, type SceneBeatClip } from './video-generation';

export const beatDuration = (beat: SceneBeat) => beat.start !== null && beat.end !== null ? beat.end - beat.start : 6;

/** Each beat is generated in its own local time, with the shared visible direction. */
export function directionForBeat(draft: SceneDraft, beat: SceneBeat): SceneDraft {
  return { ...draft, beats: [{ ...beat, start: 0, end: beatDuration(beat) }] };
}

export function beatClipMatches(draft: SceneDraft, beat: SceneBeat, job?: VideoJob): boolean {
  if (!job?.direction) return false;
  return JSON.stringify(readSceneDraft({version:1,draft:directionForBeat(draft, beat)})) === JSON.stringify(readSceneDraft({version:1,draft:job.direction}));
}

export function trackTrim(beat: SceneBeat, clip?: SceneBeatClip, job?: VideoJob) {
  const origin=job?.continuation?.startSeconds??0;
  const duration = job?.durationSeconds ?? origin+beatDuration(beat);
  // Use the measured endpoint for completed clips, so linked ranges meet exactly.
  const defaultEnd=job?.status==='ready'&&Math.abs(duration-origin-beatDuration(beat))<=0.25?duration:Math.min(origin+beatDuration(beat),duration);
  const start = Math.max(origin,Math.min(clip?.inSeconds ?? origin, Math.max(origin, duration - 0.05)));
  const end = Math.min(clip?.outSeconds ?? defaultEnd, duration);
  return { start, end: Math.max(start, end), duration: Math.max(0, end - start) };
}

/** Resolve dependency validity first, then share the newest valid source within each shot. */
export function resolveSceneTracks(draft:SceneDraft, clips:Record<string,SceneBeatClip>, jobs:Record<string,VideoJob|undefined>) {
  let previous: {beat:SceneBeat;clip?:SceneBeatClip;job?:VideoJob;trim:ReturnType<typeof trackTrim>;matches:boolean} | undefined;
  const rows=trackPositions(draft,clips,jobs).map(row=>{
    const job=row.clip?.videoId?jobs[row.clip.videoId]:undefined;
    const generationMode=row.clip?.generationMode??'new';
    const previousBeatId=previous?.beat.id;
    let continuationIssue:string|undefined;
    if(generationMode==='continue') {
      if(!previous)continuationIssue='Choose New shot for the first included beat.';
      else if(beatDuration(row.beat)<3)continuationIssue='A continuation needs at least 3 seconds of direction.';
      else if(!previous.job)continuationIssue='Generate the previous beat first.';
      else if(!previous.matches)continuationIssue='The previous beat changed. Regenerate it, then continue this beat again.';
      else if(previous.job?.status!=='ready')continuationIssue='Generate the previous beat first.';
      else if(!previous.job.canExtend)continuationIssue='The previous source cannot be continued. Choose New shot.';
      else if(Math.abs(previous.trim.end-(previous.job.durationSeconds??0))>0.001)continuationIssue='Restore the previous beat’s original ending to continue it.';
      else if((previous.job.durationSeconds??0)+Math.ceil(beatDuration(row.beat))>40.25)continuationIssue='This connected shot exceeds 40 seconds. Choose New shot.';
    }
    let matches=job?.model==='uploaded-video'?!!row.clip?.placement&&row.clip.placement.source!=='generated':beatClipMatches(draft,row.beat,job);
    if(generationMode==='continue')matches=matches&&!continuationIssue&&job?.continuation?.sourceVideoId===previous?.clip?.videoId&&Math.abs((job?.continuation?.startSeconds??-1)-previous!.trim.end)<=0.001;
    else matches=matches&&!job?.continuation;
    const needsContinuation=generationMode==='continue'&&!!job&&!matches;
    const result={...row,job,generationMode,previousBeatId,matches,needsContinuation,continuationIssue,sourceVideoId:row.clip?.videoId,sourceStart:job?.continuation?.startSeconds??0,sourceEnd:job?.durationSeconds??beatDuration(row.beat)};
    if(row.included)previous=result;
    return result;
  });
  let chain:typeof rows=[];
  for(const row of rows) {
    if(!row.included)continue;
    if(row.generationMode!=='continue'||!row.matches||row.job?.status!=='ready')chain=[];
    if(!row.matches||row.job?.status!=='ready')continue;
    chain.push(row);
    // All beat windows in a connected shot read from one continued MP4.
    for(const earlier of chain)earlier.sourceVideoId=row.clip?.videoId;
  }
  return rows;
}

export function trackPositions(draft: SceneDraft, clips: Record<string, SceneBeatClip>, jobs: Record<string, VideoJob | undefined>) {
  let time = 0;
  const beats=draft.beats.filter(beat=>beat.text.trim());
  return beats.map((beat,index) => {
    const clip = clips[beat.id];
    const trim = trackTrim(beat, clip, clip?.videoId ? jobs[clip.videoId] : undefined);
    const start = time;
    const next=beats.slice(index+1).find(beat=>!clips[beat.id]?.excluded);
    const nextClip=next?clips[next.id]:undefined;
    const nextLength=next?trackTrim(next,nextClip,nextClip?.videoId?jobs[nextClip.videoId]:undefined).duration:0;
    const transition=clip?.transition==='fade' && next && !clip.excluded ? 'fade' as const : 'cut' as const;
    const transitionSeconds=transition==='fade'?Math.min(clip?.transitionSeconds??0.5,trim.duration/2,nextLength/2):0;
    const length=clip?.placement&&!clip.timingAccepted?Math.max(beatDuration(beat),trim.duration):trim.duration;
    if (!clip?.excluded) time += length-transitionSeconds;
    return { beat, clip, trim, start, end: start + length, included: !clip?.excluded, transition, transitionSeconds };
  });
}

export function reorderBeat(draft: SceneDraft, id: string, offset: -1 | 1): SceneDraft {
  const beats = [...draft.beats]; const index = beats.findIndex(beat => beat.id === id);
  const next = index + offset;
  if (index < 0 || next < 0 || next >= beats.length) return draft;
  [beats[index], beats[next]] = [beats[next], beats[index]];
  let time = 0;
  return { ...draft, beats: beats.map(beat => {
    const duration = beatDuration(beat); const start = time; time += duration;
    return { ...beat, start, end: time };
  }) };
}
