import { expect,it } from 'bun:test';
import { runSceneGenerationQueue,type GenerationQueueBeat } from '../../studio/src/lib/scene-generation-queue';
import type { VideoJob } from '../../studio/src/lib/video-generation';

const job=(id:string,status:VideoJob['status']='ready'):VideoJob=>({id,status,model:'test',mode:'text',frame:'16:9',createdAt:0,updatedAt:0});
const ready:GenerationQueueBeat[]=[{beatId:'opening',videoId:'old-opening',included:true,matches:true,busy:false,generationMode:'new',job:job('old-opening')},{beatId:'next',videoId:'old-next',included:true,matches:true,busy:false,generationMode:'continue',job:job('old-next')}];
it('regenerates every included beat and waits for the fresh parent instead of reusing its old ready job',async()=>{
 const calls:string[]=[];
 await runSceneGenerationQueue(true,{
 read:known=>ready.map(row=>row.beatId==='next'&&known['fresh-opening']?{...row,matches:false}:row),
 submit:async(beat,known,force)=>{expect(force).toBe(true);if(beat==='next')expect(known['fresh-opening']?.status).toBe('ready');calls.push(`submit ${beat}`);return `fresh-${beat}`;},
 wait:async id=>{calls.push(`wait ${id}`);return job(id);},
 });
 expect(calls).toEqual(['submit opening','wait fresh-opening','submit next','wait fresh-next']);
});
it('reuses finished clips for the missing-only action',async()=>{
 let submissions=0;
 await runSceneGenerationQueue(false,{read:()=>ready,submit:async()=>{submissions++;return 'unwanted';},wait:async id=>job(id)});
 expect(submissions).toBe(0);
});
it('stops dependent submissions when the parent fails',async()=>{
 const calls:string[]=[];
 await expect(runSceneGenerationQueue(true,{read:()=>ready,submit:async beat=>{calls.push(beat);return `fresh-${beat}`;},wait:async id=>({...job(id,'error'),message:'Provider unavailable'})})).rejects.toThrow('Provider unavailable');
 expect(calls).toEqual(['opening']);
});
