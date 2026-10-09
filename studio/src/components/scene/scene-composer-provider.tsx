"use client";

import {useSearchParams} from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createSceneDraft, readSceneDraft, type SceneDraft } from "@/lib/scene-direction";
import { MAX_IMAGE_BYTES, MAX_REFERENCE_IMAGES, type VideoJob, type SceneBeatClip, type VideoExportClip } from "@/lib/video-generation";
import { directionForBeat, resolveSceneTracks, reorderBeat } from "@/lib/scene-tracks";
import type { AudioPlacement } from "@/lib/audio-placement";
import {placementNeedsRecording,retainTake,restoreScriptAudio} from '@/lib/script-timeline';
import { runSceneGenerationQueue } from '@/lib/scene-generation-queue';
import {assertGenerationContinuity} from '@/lib/script-continuity';
import {saveVideoPlan} from './save-video-plan';
import { authenticatedVideoFetch, useVideoJobs, isClipBusy, type ClipState } from "./use-video-jobs";
import { useWorkspace } from "@/components/shell/workspace-provider";

export interface SceneImage { id: string; name: string; url: string; file: File }
interface SceneImages { firstFrame: SceneImage | null; references: SceneImage[] }
export interface SceneTrack extends ClipState { candidate?:ClipState; timingIssue?:string; beat: SceneDraft['beats'][number]; clip?: SceneBeatClip; start: number; end: number; trim: {start:number;end:number;duration:number}; included: boolean; matches: boolean; ready: boolean; busy: boolean; transition:'cut'|'fade';transitionSeconds:number;generationMode:'new'|'continue';previousBeatId?:string;needsContinuation:boolean;continuationIssue?:string;sourceVideoId?:string;sourceStart:number;sourceEnd:number }
interface SceneComposerState {
  draft: SceneDraft;
  title:string;
  setTitle:(title:string)=>void;
  audioPlacements:AudioPlacement[];
  setAudioPlacements:(clips:AudioPlacement[])=>void;
  playhead:number;
  setPlayhead:(time:number)=>void;
  selectedAudioId:string|null;
  selectAudio:(id:string|null)=>void;
  trackView: boolean;
  setTrackView: (enabled: boolean) => void;
  tracks: SceneTrack[];
  selectedBeatId: string;
  selectBeat: (id: string) => void;
  generateBeat: (id: string) => Promise<void>;
  attachRecording: (beatId:string,sourceId:string) => Promise<void>;
  acceptCandidate: (beatId:string) => void;
  discardCandidate: (beatId:string) => void;
  restoreTake: (beatId:string,index:number) => void;
  generateMissingBeats: () => Promise<void>;
  regenerateAllBeats: () => Promise<void>;
  batchRunning:boolean;
  activeVideoCount:number;
  batchIssue?:string;
  batchProgress?:string;
  updateBeatClip: (id: string, patch: Partial<Omit<SceneBeatClip,"videoId">>) => void;
  moveBeat: (id: string, offset: -1 | 1) => void;
  exportScene: () => Promise<void>;
  exportJob?: VideoJob;
  exportUrl?: string;
  exporting: boolean;
  exportIssue?: string;
  exportRequestId?: string;
  exportCurrent: boolean;
  reloadJob: (id: string) => void;
  downloadJob: (id: string) => void;
  updateDraft: (patch: Partial<SceneDraft>) => void;
  firstFrame: SceneImage | null;
  references: SceneImage[];
  attachFirstFrame: (file: File) => string | null;
  attachReferences: (files: File[]) => string | null;
  removeFirstFrame: () => void;
  removeReference: (id: string) => void;
  ready: boolean;
  storageAvailable: boolean;
  job: VideoJob | null;
  videoUrl?: string;
  generating: boolean;
  generationIssue?: string;
  generate: () => Promise<void>;
  reloadClip: () => void;
  downloadClip: () => void;
  reportPlaybackDuration: (seconds: number) => void;
}
const SceneContext = createContext<SceneComposerState | null>(null);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EMPTY_IMAGES: SceneImages = { firstFrame: null, references: [] };
const imageFromFile = (file: File): SceneImage => ({ id: crypto.randomUUID(), name: file.name, url: URL.createObjectURL(file), file });
const validateImage = (file: File) => !IMAGE_TYPES.has(file.type) ? "Choose a PNG, JPEG, or WebP image." : !file.size || file.size > MAX_IMAGE_BYTES ? "Choose an image under 10 MB." : null;

/** One account-scoped controller lives above the page and inspector. Requests survive route changes. */
export function SceneComposerProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const { state, store, draftId, activeTab, storageUnavailable } = useWorkspace();
  const isScene = activeTab?.href.split('?')[0] === '/studio/scene';
  const record = state.sceneDrafts[draftId];
  useEffect(()=>{
    if(!record)return;
    const upgraded=restoreScriptAudio(record);
    if(upgraded!==record){store.setSceneDraft(draftId,upgraded);store.flush();}
  },[record,store,draftId]);
  const importedProject = useSearchParams().get('project');
  const seed = useMemo(() => createSceneDraft(), []);
  const draft = record?.draft ?? seed;
  const [imagesByDraft, setImagesByDraft] = useState<Record<string, SceneImages>>({});
  const jobs = useVideoJobs(Object.values(state.sceneDrafts).flatMap(scene => [scene.videoId, scene.exportId, ...Object.values(scene.beatClips ?? {}).flatMap(clip => [clip.videoId,clip.pendingVideoId])].filter((id): id is string => !!id)));
  const { clips } = jobs;
  const { reportDuration } = jobs;
  const submitting = useRef(new Set<string>());
  const beatSubmissions = useRef(new Set<string>());
  const batchSubmissions=useRef(new Set<string>());
  const [batches,setBatches]=useState<Record<string,{running:boolean;issue?:string;progress?:string}>>({});
  const ownedUrls = useRef(new Set<string>());
  const [playheads,setPlayheads]=useState<Record<string,number>>({});
  const [audioSelection,setAudioSelection]=useState<Record<string,string|null>>({});
  const [selectedByDraft, setSelectedByDraft] = useState<Record<string,string>>({});
  const images = imagesByDraft[draftId] ?? EMPTY_IMAGES;
  const clip = record?.videoId ? clips[record.videoId] : undefined;
  const generating = !!record?.videoId && isClipBusy(clip);
  const positions = resolveSceneTracks(draft, record?.beatClips ?? {}, Object.fromEntries(Object.entries(clips).map(([id, clip]) => [id, clip.job])));
  const tracks: SceneTrack[] = positions.map(row => {
    const state = row.clip?.videoId ? clips[row.clip.videoId] : undefined;
    const source=row.sourceVideoId?clips[row.sourceVideoId]:undefined;
    const candidate=row.clip?.pendingVideoId?clips[row.clip.pendingVideoId]:undefined;
    const timingIssue=row.clip?.placement&&!row.clip.timingAccepted&&(row.trim.duration+.05<(row.beat.end??0)-(row.beat.start??0)||row.job?.status==='partial')&&!!row.job?.durationSeconds?'Review the saved footage and its usable duration before export.':undefined;
    return { ...state, ...row, candidate,timingIssue,url:source?.url,issue:state?.issue??source?.issue, ready: row.matches && (state?.job?.status === 'ready'||state?.job?.status==='partial'&&!!row.clip?.timingAccepted) && row.trim.duration > 0&&!timingIssue, busy: !!row.clip?.videoId && isClipBusy(state)||!!row.clip?.pendingVideoId&&isClipBusy(candidate) };
  });
  const selectedBeatId = tracks.some(track => track.beat.id === selectedByDraft[draftId]) ? selectedByDraft[draftId] : tracks[0]?.beat.id ?? draft.beats[0].id;
  const exportClip = record?.exportId ? clips[record.exportId] : undefined;
  const exportInputs: VideoExportClip[] = tracks.filter(track => track.included).flatMap(track => track.sourceVideoId ? [{videoId:track.sourceVideoId,inSeconds:track.trim.start,outSeconds:track.trim.end,muted:!!track.clip?.muted,transition:track.transition,transitionSeconds:track.transitionSeconds}] : []);
  const exportCurrent = tracks.filter(track => track.included).every(track => track.ready) && JSON.stringify(exportInputs) === JSON.stringify(exportClip?.job?.exportInputs)&&JSON.stringify(record?.audioPlacements??[])===JSON.stringify(exportClip?.job?.exportAudio??[]);
  useEffect(() => {
    if (!isScene || record || importedProject) return;
    let restored: SceneDraft | null = null;
    // Migrate the previous one-scene prototype once, into the default workspace draft.
    if (draftId === 'default') {
      try { restored = readSceneDraft(JSON.parse(localStorage.getItem(`mdmedia.scene-draft.v1.${accountId}`) ?? 'null')); } catch { /* keep seed */ }
    }
    queueMicrotask(() => {
      if (!store.getSnapshot().sceneDrafts[draftId]) store.setSceneDraft(draftId, { draft: restored ?? seed });
    });
  }, [accountId, draftId, isScene, record, seed, store, importedProject]);

  useEffect(() => () => { for (const url of ownedUrls.current) URL.revokeObjectURL(url); }, []);
  const updateDraft = useCallback((patch: Partial<SceneDraft>) => {
    if (!isScene) return;
    const latest = store.getSnapshot().sceneDrafts[draftId];
    store.setSceneDraft(draftId, { ...latest, draft: { ...(latest?.draft ?? seed), ...patch } });
  }, [draftId, isScene, seed, store]);
  const updateImages = (next: SceneImages) => setImagesByDraft(current => ({ ...current, [draftId]: next }));
  const releaseImage = (image: SceneImage | null) => {
    if (image) { URL.revokeObjectURL(image.url); ownedUrls.current.delete(image.url); }
  };
  const attachFirstFrame = (file: File) => {
    const problem = validateImage(file); if (problem) return problem;
    const image = imageFromFile(file); ownedUrls.current.add(image.url);
    releaseImage(images.firstFrame); updateImages({ ...images, firstFrame: image });
    if (draft.mode === 'text') updateDraft({ mode: 'image' });
    return null;
  };
  const attachReferences = (files: File[]) => {
    const problem = files.map(validateImage).find(Boolean); if (problem) return problem;
    if (images.references.length + files.length > MAX_REFERENCE_IMAGES) return 'Use up to six reference images.';
    const added = files.map(imageFromFile); added.forEach(image => ownedUrls.current.add(image.url));
    updateImages({ ...images, references: [...images.references, ...added] });
    if (draft.mode === 'text') updateDraft({ mode: 'references' });
    return null;
  };
  const removeFirstFrame = () => { releaseImage(images.firstFrame); updateImages({ ...images, firstFrame: null }); };
  const removeReference = (id: string) => {
    releaseImage(images.references.find(image => image.id === id) ?? null);
    updateImages({ ...images, references: images.references.filter(image => image.id !== id) });
  };
  const generate = async () => {
    if (generating || submitting.current.has(draftId) || !isScene) return;
    const snapshot = store.getSnapshot().sceneDrafts[draftId]?.draft ?? draft;
    const resume = clip?.job?.status === 'partial' && clip.job.canContinue && JSON.stringify(clip.job.direction) === JSON.stringify(snapshot) && !!record?.videoId;
    const id = resume ? record!.videoId! : `v_${crypto.randomUUID().replaceAll('-', '')}`;
    const form = new FormData();
    form.set('id', id); form.set('draft', JSON.stringify(snapshot));
    if (snapshot.mode !== 'text') {
      if (images.firstFrame) form.set('firstFrame', images.firstFrame.file);
      for (const image of images.references) form.append('reference', image.file);
    }
    submitting.current.add(draftId);
    store.setSceneDraft(draftId, { ...store.getSnapshot().sceneDrafts[draftId], draft: snapshot, videoId: id });
    store.flush();
    try { await jobs.submit(id, resume ? `/api/videos/${id}/resume` : '/api/videos', resume ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:snapshot})} : {method:'POST',body:form}); }
    finally { submitting.current.delete(draftId); }
  };
  const reloadClip = () => { if (record?.videoId) jobs.reload(record.videoId); };
  const downloadClip = () => { if (record?.videoId) jobs.download(record.videoId); };
  const reportPlaybackDuration = useCallback((seconds:number) => {
    const id = store.getSnapshot().sceneDrafts[draftId]?.videoId;
    if (id) reportDuration(id, seconds);
  }, [draftId, store, reportDuration]);
  const patchRecord = (patch: Partial<NonNullable<typeof record>>) => {
    const latest = store.getSnapshot().sceneDrafts[draftId];
    if (latest) store.setSceneDraft(draftId, {...latest,...patch});
  };
  const submitBeat = async (beatId:string,knownJobs:Record<string,VideoJob>={},fromBatch=false,force=false):Promise<string|undefined> => {
    const lock = draftId + ':' + beatId;
    if (!isScene || beatSubmissions.current.has(lock)||batchSubmissions.current.has(draftId)&&!fromBatch) return;
    const latest = store.getSnapshot().sceneDrafts[draftId];
    const beat = latest?.draft.beats.find(beat => beat.id === beatId);
    if (!latest || !beat?.text.trim()) return;
    try{assertGenerationContinuity(latest);}catch(error){setBatches(current=>({...current,[draftId]:{running:fromBatch,issue:error instanceof Error?error.message:'Check scene continuity.'}}));return;}
    const existing = latest.beatClips?.[beatId];
    if(placementNeedsRecording(existing)||existing?.pendingVideoId)return;
    const states=jobs.currentStates();
    const saved = existing?.videoId ? {...states[existing.videoId],...(knownJobs[existing.videoId]?{job:knownJobs[existing.videoId]}:{})} : undefined;
    if (existing?.videoId && isClipBusy(saved)) return;
    const resolved=resolveSceneTracks(latest.draft,latest.beatClips??{},{...Object.fromEntries(Object.entries(states).map(([id,state])=>[id,state.job])),...knownJobs});
    const row=resolved.find(row=>row.beat.id===beatId)!;
    if(row.generationMode==='continue'&&row.continuationIssue){setBatches(current=>({...current,[draftId]:{running:fromBatch,issue:row.continuationIssue}}));return;}
    const previous=resolved.find(previous=>previous.beat.id===row.previousBeatId);
    if(row.generationMode==='continue'&&previous?.clip?.pendingVideoId){setBatches(current=>({...current,[draftId]:{running:fromBatch,issue:'Review and accept the previous beat’s replacement before generating its continuation.'}}));return;}
    const snapshot = directionForBeat(latest.draft, beat);
    const resume = !force && saved?.job?.status === 'partial' && saved.job.canContinue && row.matches;
    const id = resume ? existing!.videoId! : `v_${crypto.randomUUID().replaceAll('-','')}`;
    beatSubmissions.current.add(lock);
    if(!fromBatch)setBatches(current=>({...current,[draftId]:{running:false}}));
    const nextClip: SceneBeatClip = resume ? existing! : existing?.placement&&existing.videoId&&saved?.job?.durationSeconds ? {...existing,pendingVideoId:id} : {placement:existing?.placement,videoId:id, muted:existing?.muted ?? false, excluded:existing?.excluded ?? false,generationMode:row.generationMode,transition:existing?.transition ?? 'cut',transitionSeconds:existing?.transitionSeconds??0.5};
    const nextRecord={...latest,beatClips:{...latest.beatClips,[beatId]:nextClip}};
    const form = new FormData(); form.set('id',id); form.set('draft',JSON.stringify(snapshot)); form.set('scope','beat');
    if (snapshot.mode !== 'text') {
      if (images.firstFrame) form.set('firstFrame',images.firstFrame.file);
      images.references.forEach(image => form.append('reference',image.file));
    }
    const continuing=row.generationMode==='continue';
    try {
      await saveVideoPlan(draftId,nextRecord);
      if(store.getSnapshot().sceneDrafts[draftId]!==latest)throw new Error('The scene changed while its plan was saving. Generate again using the latest direction.');
      store.setSceneDraft(draftId,nextRecord);store.flush();
      const accepted=await jobs.submit(id, resume ? `/api/videos/${id}/resume` : continuing?'/api/videos/continue':'/api/videos', resume||continuing ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(resume?{draft:snapshot}:{id,draft:snapshot,sourceVideoId:previous!.clip!.videoId,sourceEndSeconds:previous!.trim.end})} : {method:'POST',body:form});
      if(!accepted)return;
      return id;
    }
    catch(error){setBatches(current=>({...current,[draftId]:{running:fromBatch,issue:error instanceof Error?error.message:'Could not save the generation plan.'}}));if(fromBatch)throw error;}
    finally { beatSubmissions.current.delete(lock); }
  };
  const generateBeats = async (force=false) => {
    if(batchSubmissions.current.has(draftId)||Object.values(store.getSnapshot().sceneDrafts[draftId]?.beatClips??{}).some(clip=>clip.pendingVideoId))return;
    batchSubmissions.current.add(draftId);setBatches(current=>({...current,[draftId]:{running:true}}));
    try{
      const plan=store.getSnapshot().sceneDrafts[draftId];
      if(!plan)return;
      await saveVideoPlan(draftId,plan);
      assertGenerationContinuity(plan);
      await runSceneGenerationQueue(force,{
      read:knownJobs=>{
        const latest=store.getSnapshot().sceneDrafts[draftId];if(!latest)return [];
        const states=jobs.currentStates();
        const rows=resolveSceneTracks(latest.draft,latest.beatClips??{},{...Object.fromEntries(Object.entries(states).map(([id,state])=>[id,state.job])),...knownJobs});
        return rows.filter(row=>!placementNeedsRecording(row.clip)).map(row=>({...row,beatId:row.beat.id,videoId:row.clip?.videoId,busy:!!row.clip?.videoId&&isClipBusy({...states[row.clip.videoId],...(knownJobs[row.clip.videoId]?{job:knownJobs[row.clip.videoId]}:{})})}));
      },submit:(beatId,knownJobs,force)=>submitBeat(beatId,knownJobs,true,force),wait:jobs.waitForJob,
      onProgress:(_beatId,index,total)=>setBatches(current=>({...current,[draftId]:{running:true,progress:`${force?'Regenerating':'Generating'} beat ${index} of ${total}`}})),
      });
      setBatches(current=>({...current,[draftId]:{running:false}}));
    }catch(error){setBatches(current=>({...current,[draftId]:{running:false,issue:error instanceof Error?error.message:'The continuation queue stopped. Your clips are saved.'}}));}
    finally{batchSubmissions.current.delete(draftId);}
  };
  const attachRecording = async (beatId:string,sourceId:string) => {
    const latest=store.getSnapshot().sceneDrafts[draftId];
    const saved=latest?.beatClips?.[beatId];
    if(!latest||!saved?.placement||beatSubmissions.current.has(draftId+':'+beatId))throw new Error('This section is unavailable or busy.');
    const id=`v_${crypto.randomUUID().replaceAll('-','')}`;
    await authenticatedVideoFetch('/api/videos/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,sourceId,frame:latest.draft.frame})});
    const current=store.getSnapshot().sceneDrafts[draftId];const clip=current?.beatClips?.[beatId];
    if(!current||!clip)throw new Error('The section was removed. Your recording remains saved.');
    store.setSceneDraft(draftId,{...current,beatClips:{...current.beatClips,[beatId]:{...clip,...(clip.videoId?{pendingVideoId:id}:{videoId:id,inSeconds:0,outSeconds:undefined,timingAccepted:false}),generationMode:'new'}}});store.flush();
  };
  const acceptCandidate = (beatId:string) => {
    const latest=store.getSnapshot().sceneDrafts[draftId], clip=latest?.beatClips?.[beatId];
    const candidate=clip?.pendingVideoId?jobs.currentStates()[clip.pendingVideoId]?.job:undefined;
    if(!latest||!clip||!candidate||!['ready','partial'].includes(candidate.status))return;
    store.setSceneDraft(draftId,{...latest,beatClips:{...latest.beatClips,[beatId]:{...clip,videoId:candidate.id,pendingVideoId:undefined,inSeconds:undefined,outSeconds:undefined,timingAccepted:false,takeHistory:retainTake(clip)}}});store.flush();
  };
  const discardCandidate = (beatId:string) => {
    const latest=store.getSnapshot().sceneDrafts[draftId],clip=latest?.beatClips?.[beatId];if(!latest||!clip)return;
    store.setSceneDraft(draftId,{...latest,beatClips:{...latest.beatClips,[beatId]:{...clip,pendingVideoId:undefined}}});
  };
  const restoreTake = (beatId:string,index:number) => {
    const latest=store.getSnapshot().sceneDrafts[draftId],clip=latest?.beatClips?.[beatId],take=clip?.takeHistory?.[index];if(!latest||!clip||!take)return;
    store.setSceneDraft(draftId,{...latest,beatClips:{...latest.beatClips,[beatId]:{...clip,...take,pendingVideoId:undefined,timingAccepted:false,takeHistory:retainTake(clip).filter(entry=>entry.videoId!==take.videoId)}}});store.flush();
  };
  const updateBeatClip = (beatId:string, patch: Partial<Omit<SceneBeatClip,'videoId'>>) => {
    const latest = store.getSnapshot().sceneDrafts[draftId]; const saved = latest?.beatClips?.[beatId];
    if (latest) patchRecord({beatClips:{...latest.beatClips,[beatId]:{...saved,...patch}}});
  };
  const exportScene = async () => {
    if (submitting.current.has('export:'+draftId) || exportInputs.length === 0 || tracks.some(track => track.included && !track.ready) || record?.exportId && isClipBusy(exportClip)) return;
    submitting.current.add('export:'+draftId);
    const id = `v_${crypto.randomUUID().replaceAll('-','')}`;
    patchRecord({exportId:id}); store.flush();
    try { await jobs.submit(id,'/api/videos/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,clips:exportInputs,frame:draft.frame,audio:record?.audioPlacements??[]})}); }
    finally { submitting.current.delete('export:'+draftId); }
  };
  return <SceneContext.Provider value={{ draft, updateDraft,title:record?.title??"Untitled video",setTitle:title=>patchRecord({title}),audioPlacements:record?.audioPlacements??[],setAudioPlacements:audioPlacements=>patchRecord({audioPlacements}),playhead:playheads[draftId]??0,setPlayhead:time=>setPlayheads(current=>({...current,[draftId]:time})),selectedAudioId:audioSelection[draftId]??null,selectAudio:id=>setAudioSelection(current=>({...current,[draftId]:id})), firstFrame: images.firstFrame, references: images.references,
    trackView:record?.view === 'tracks', setTrackView:enabled=>patchRecord({view:enabled?'tracks':'writing'}), tracks, selectedBeatId, selectBeat:id=>{setAudioSelection(current=>({...current,[draftId]:null}));setSelectedByDraft(current=>({...current,[draftId]:id}));},
    attachRecording,acceptCandidate,discardCandidate,restoreTake,generateBeat:async id=>{await submitBeat(id);}, activeVideoCount:Object.values(clips).filter(clip=>clip.job?.status==='generating'||clip.job?.status==='saving').length,generateMissingBeats:()=>generateBeats(),regenerateAllBeats:()=>generateBeats(true),batchRunning:!!batches[draftId]?.running,batchIssue:batches[draftId]?.issue,batchProgress:batches[draftId]?.progress, updateBeatClip, moveBeat:(id,offset)=>updateDraft(reorderBeat(draft,id,offset)), exportScene, exportJob:exportClip?.job, exportUrl:exportClip?.url, exporting:!!record?.exportId && isClipBusy(exportClip), exportIssue:exportClip?.issue, exportRequestId:record?.exportId, exportCurrent, reloadJob:jobs.reload,downloadJob:jobs.download,
    attachFirstFrame, attachReferences, removeFirstFrame, removeReference, ready: isScene && !!record, storageAvailable: !storageUnavailable,
    job: clip?.job ?? null, videoUrl: clip?.url, generating, generationIssue: clip?.issue, generate, reloadClip, downloadClip, reportPlaybackDuration }}>{children}</SceneContext.Provider>;
}
export function useSceneComposer() {
  const value = useContext(SceneContext);
  if (!value) throw new Error('Scene composer controls require SceneComposerProvider');
  return value;
}
