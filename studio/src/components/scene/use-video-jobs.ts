"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { currentIdToken } from '@/lib/firebase';
import { VIDEO_TIMEOUT_MS, type VideoJob } from '@/lib/video-generation';

export interface ClipState { job?: VideoJob; url?: string; issue?: string; submitting?: boolean; unresolved?: boolean;submittedAt?:number;lastCheckedAt?:number }
class VideoHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function authenticatedVideoFetch(url: string, init: RequestInit = {}) {
  const token = await currentIdToken();
  if (!token) throw new VideoHttpError('Please sign in to generate and view videos.', 401);
  const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new VideoHttpError(error?.message ?? 'Video generation could not be reached. Try again.', response.status);
  }
  return response;
}
export const isClipBusy = (clip?: ClipState) => !!clip?.submitting || !!clip?.unresolved || clip?.job?.status === 'generating' || clip?.job?.status === 'saving' || !clip?.job && !clip?.issue;

/** Private media and request state shared by whole-scene, beat, and export jobs. */
export function useVideoJobs(ids: string[]) {
  const [clips, setClips] = useState<Record<string, ClipState>>({});
  const clipsRef = useRef(clips); const requests = useRef(new Set<string>());
  const ownedUrls = useRef(new Set<string>()); const [refresh, setRefresh] = useState(0);
  const [manualChecks,setManualChecks]=useState<string[]>([]);
  const waiters=useRef(new Set<AbortController>());
  useEffect(() => { clipsRef.current = clips; }, [clips]);
  const targets = [...new Set(ids)].filter(id => {
    const clip = clips[id];
    return manualChecks.includes(id)||!clip?.submitting && !clip?.issue && (!clip?.job || clip.job.status === 'generating' || clip.job.status === 'saving' || (clip.job.status === 'ready' || clip.job.status === 'partial') && !clip.url);
  }).sort().join(',');
  useEffect(() => {
    if (!targets) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const update = (id: string, patch: ClipState) => setClips(current => ({ ...current, [id]: { ...current[id], ...patch } }));
    const poll = async () => {
      await Promise.all(targets.split(',').map(async id => {
        try {
          const response = await authenticatedVideoFetch(`/api/videos/${id}`, { signal: controller.signal });
          const { job } = await response.json() as { job: VideoJob };
          if (controller.signal.aborted) return;
          update(id, { job, issue: undefined, unresolved: false,lastCheckedAt:Date.now() });
          if ((job.status === 'ready' || job.status === 'partial') && !clipsRef.current[id]?.url) {
            const media = await authenticatedVideoFetch(`/api/videos/${id}/media`, { signal: controller.signal });
            const blob = await media.blob(); if (controller.signal.aborted) return;
            const url = URL.createObjectURL(blob); ownedUrls.current.add(url); update(id, { url });
          }
          setManualChecks(current=>current.filter(value=>value!==id));
        } catch (error) {
          if (!controller.signal.aborted){update(id, { issue: error instanceof Error ? error.message : 'The video could not be loaded.', unresolved: !clipsRef.current[id]?.job && !(error instanceof VideoHttpError && error.status === 404) });setManualChecks(current=>current.filter(value=>value!==id));}
        }
      }));
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [targets, refresh]);
  useEffect(() => () => { for (const url of ownedUrls.current) URL.revokeObjectURL(url); for(const controller of waiters.current)controller.abort(); }, []);
  const submit = async (id: string, url: string, init: RequestInit) => {
    if (requests.current.has(id)) return;
    requests.current.add(id);
    const submittedAt=Date.now();
    setClips(current => ({ ...current, [id]: { ...current[id], submitting: true, issue: undefined,submittedAt } }));
    try {
      const response = await authenticatedVideoFetch(url, init);
      const { job } = await response.json() as { job: VideoJob };
      setClips(current => {
        const oldUrl = current[id]?.url;
        if (oldUrl) { URL.revokeObjectURL(oldUrl); ownedUrls.current.delete(oldUrl); }
        return { ...current, [id]: { job,submittedAt,lastCheckedAt:Date.now() } };
      });
      return job;
    } catch (error) {
      setClips(current => ({ ...current, [id]: { ...current[id], submitting: false, issue: error instanceof Error ? error.message : 'Could not submit your video.', unresolved: !(error instanceof VideoHttpError && error.status < 500) } }));
    } finally { requests.current.delete(id); }
  };
  const reload = (id: string) => {
    setClips(current => ({ ...current, [id]: { ...current[id], issue: undefined } }));setManualChecks(current=>[...new Set([...current,id])]); setRefresh(current => current + 1);
  };
  const download = (id: string) => {
    const url = clips[id]?.url; if (!url) return;
    const link = document.createElement('a'); link.href = url; link.download = `${id}.mp4`;
    document.body.append(link); link.click(); link.remove();
  };
  const reportDuration = useCallback((id: string, seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setClips(current => {
      const previous = current[id]; if (!previous?.job || previous.job.durationSeconds === seconds) return current;
      return { ...current, [id]: { ...previous, job: { ...previous.job, durationSeconds: seconds } } };
    });
  }, []);
  const waitForJob=async(id:string):Promise<VideoJob>=>{
    const controller=new AbortController();waiters.current.add(controller);
    const deadline=Date.now()+VIDEO_TIMEOUT_MS+60000;
    try{
      while(Date.now()<deadline&&!controller.signal.aborted){
        const response=await authenticatedVideoFetch(`/api/videos/${id}`,{signal:controller.signal});
        const {job}=await response.json() as {job:VideoJob};
        setClips(current=>({...current,[id]:{...current[id],job,issue:undefined,unresolved:false,lastCheckedAt:Date.now()}}));
        if(job.status!=='generating'&&job.status!=='saving')return job;
        await new Promise<void>((resolve,reject)=>{
          const abort=()=>{clearTimeout(timer);reject(new Error('The continuation queue was closed.'));};
          const timer=setTimeout(()=>{controller.signal.removeEventListener('abort',abort);resolve();},2500);
          controller.signal.addEventListener('abort',abort,{once:true});
        });
      }
      throw new Error('The previous beat did not finish. Check its status before continuing.');
    }finally{waiters.current.delete(controller);}
  };
  return { clips, currentStates:()=>clipsRef.current, waitForJob, submit, reload, download, reportDuration };
}
