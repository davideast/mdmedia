import type { VideoJob } from './video-generation';

export interface GenerationQueueBeat {
  beatId:string;
  videoId?:string;
  included:boolean;
  matches:boolean;
  busy:boolean;
  generationMode:'new'|'continue';
  job?:VideoJob;
  continuationIssue?:string;
}
interface GenerationQueueDependencies {
  read:(knownJobs:Record<string,VideoJob>)=>GenerationQueueBeat[];
  submit:(beatId:string,knownJobs:Record<string,VideoJob>,force:boolean)=>Promise<string|undefined>;
  wait:(id:string)=>Promise<VideoJob>;
  onProgress?:(beatId:string,index:number,total:number)=>void;
}

/** One scene action, with fresh dependency state before every submitted beat. */
export async function runSceneGenerationQueue(force:boolean,dependencies:GenerationQueueDependencies) {
  const knownJobs:Record<string,VideoJob>={};
  const beatIds=dependencies.read(knownJobs).filter(row=>row.included).map(row=>row.beatId);
  for(let index=0;index<beatIds.length;index++) {
    const rows=dependencies.read(knownJobs);
    const row=rows.find(row=>row.beatId===beatIds[index]);if(!row?.included)continue;
    dependencies.onProgress?.(row.beatId,index+1,beatIds.length);
    const id=row.busy||!force&&row.matches&&row.job?.status==='ready'?row.videoId:await dependencies.submit(row.beatId,knownJobs,force);
    if(!id)throw new Error(row.continuationIssue??'Check this beat’s status before continuing.');
    {
      const job=id===row.videoId&&row.matches&&row.job?.status==='ready'?row.job:await dependencies.wait(id);
      knownJobs[id]=job;
      if(job.status!=='ready')throw new Error(job.message||'This shot could not finish. Completed shots are saved; retry to continue.');
    }
  }
}
