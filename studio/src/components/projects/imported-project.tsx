'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import type {ProjectImport} from '../../../../src/projects/index';
import {authenticatedVideoFetch} from '@/components/scene/use-video-jobs';
import {useWorkspace} from '@/components/shell/workspace-provider';
import {SceneComposer} from '@/components/scene/scene-composer';
import type {SceneDraftRecord} from '@/lib/video-generation';
interface SavedProject {project:ProjectImport;drafts:{id:string;record:SceneDraftRecord}[];reviewNotes:string[]}
function useImportedProject(id:string){
  const [result,setResult]=useState<{id:string;data?:SavedProject;error?:string}>();
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    void authenticatedVideoFetch(`/api/studio-projects/${encodeURIComponent(id)}`,{signal:controller.signal})
      .then(response=>response.json()).then((data:SavedProject)=>{if(!controller.signal.aborted)setResult({id,data});})
      .catch(error=>{if(!controller.signal.aborted)setResult({id,error:error.message});});
    return()=>controller.abort();
  },[id,attempt]);
  return {data:result?.id===id?result.data:undefined,error:result?.id===id?result.error:undefined,retry:()=>setAttempt(n=>n+1)};
}
export function ImportedProject({id}:{id:string}){
  const {data,error,retry}=useImportedProject(id);
  if(error)return <p role="alert">{error} <button onClick={retry}>Retry</button></p>;
  if(!data)return <p role="status">Loading saved project…</p>;
  return <section className="grid gap-6">
    <div><Link href="/projects" className="text-sm underline">All projects</Link><h1 className="mt-4 t-h2">{data.project.title}</h1><p className="mt-2 text-sm text-ink-muted">Your screenplay is arranged into parts. Open a part to build its video or refine the script.</p></div>
    <div className="grid gap-3">{data.drafts.map(({id: draftId,record},index)=><Link key={draftId} href={`/studio/scene?draft=${draftId}&project=${id}`} className="rounded border border-border p-4 hover:bg-secondary"><strong>{record.title}</strong><p className="mt-2 text-sm text-ink-muted">Part {index+1} / {record.draft.beats.length} shots / {record.videoBrief?.targetSeconds}s planned</p></Link>)}</div>
    <p className="text-sm text-ink-muted">{data.project.productionNotes.toLowerCase().includes('condensed adaptation')?'Condensed adaptation · ':''}{Math.round(data.drafts.reduce((seconds,{record})=>seconds+(record.videoBrief?.targetSeconds??0),0)/60)} minutes across {data.drafts.length} parts · Dialogue and sound included in generation.</p>
    <details><summary>Production direction and character continuity</summary><p className="mt-3 whitespace-pre-wrap text-sm text-ink-muted">{data.project.productionNotes}</p></details>
    <p className="text-xs text-ink-muted">The imported plan is saved to your account. Timeline edits are currently saved in this browser; reopening preserves those edits.</p>
  </section>;
}
export function ImportedScene({projectId}:{projectId:string}){
  const {data,error,retry}=useImportedProject(projectId);
  const {store,state,draftId}=useWorkspace();
  const imported=data?.drafts.find(draft=>draft.id===draftId);
  useEffect(()=>{
    if(imported&&!store.getSnapshot().sceneDrafts[imported.id]){
      store.setSceneDraft(imported.id,imported.record);store.flush();
    }
  },[imported,store]);
  if(error)return <p className="p-6" role="alert">{error} <button onClick={retry}>Retry</button></p>;
  if(!data)return <p className="p-6" role="status">Opening the saved timeline…</p>;
  if(!imported)return <p className="p-6" role="alert">This timeline does not belong to the selected project.</p>;
  if(!state.sceneDrafts[draftId])return <p className="p-6" role="status">Preparing the timeline…</p>;
  return <><div className="border-b border-border px-4 py-2 text-xs"><Link href={`/projects?import=${projectId}`} className="underline">{data.project.title}</Link><span className="ml-4 text-ink-muted">Script → Video</span></div><SceneComposer/></>;
}
export function SavedProjects(){
  const [projects,setProjects]=useState<{id:string;title:string;parts:number}[]>([]);
  const [error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    void authenticatedVideoFetch('/api/studio-projects',{signal:controller.signal}).then(r=>r.json()).then(data=>{if(!controller.signal.aborted)setProjects(data.projects);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[]);
  return <section className="grid gap-3"><h2 className="font-medium">Saved production plans</h2>{error?<p role="alert">{error}</p>:projects.length?projects.map(p=><Link key={p.id} href={`/projects?import=${p.id}`} className="rounded border border-border p-4 text-sm hover:bg-secondary">{p.title}<span className="ml-3 text-ink-muted">{p.parts} parts</span></Link>):<p className="text-sm text-ink-muted">Plans imported by your agent will appear here.</p>}</section>;
}
