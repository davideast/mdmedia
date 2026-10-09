import type { VideoJob } from './video-generation';

export interface BeatGenerationState {
 job?:VideoJob;issue?:string;submitting?:boolean;unresolved?:boolean;submittedAt?:number;
 busy:boolean;ready:boolean;matches:boolean;needsContinuation:boolean;continuationIssue?:string;
}
export function beatGenerationStatus(track:BeatGenerationState) {
 if(track.issue)return 'Check status';
 if(track.submitting)return 'Submitting';
 if(track.unresolved||track.busy&&!track.job)return 'Checking status';
 if(track.busy)return track.job?.status==='saving'?'Saving':'Generating';
 if(track.needsContinuation)return 'Needs continuation';
 if(track.continuationIssue)return 'Blocked';
 if(track.job?.status==='error')return 'Generation failed';
 if(track.job?.status==='partial')return 'Partial clip';
 if(track.job&&!track.matches)return 'Direction changed';
 return track.ready?'Ready':'Not generated';
}
export function beatGenerationFeedback(track:BeatGenerationState,now:number) {
 const status=beatGenerationStatus(track);
 const active=track.busy&&!track.issue;
 const start=track.submittedAt??track.job?.createdAt;
 const seconds=active&&start!==undefined?Math.max(0,Math.floor((now-start)/1000)):undefined;
 const elapsed=seconds===undefined?undefined:`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} elapsed`;
 let detail:string;
 if(track.issue)detail=track.issue;
 else if(track.submitting)detail='Sending this beat to the video model.';
 else if(track.unresolved||track.busy&&!track.job)detail='Checking whether the server accepted this beat. No new generation is being submitted.';
 else if(track.busy)detail=track.job?.message?.trim()||(track.job?.status==='saving'?'Saving the generated footage.':'Waiting for the video model.');
 else if(track.continuationIssue)detail=`Not generating. ${track.continuationIssue}`;
 else if(track.job?.status==='error'||track.job?.status==='partial')detail=track.job.message?.trim()||'The requested beat did not finish. Your direction is saved.';
 else if(track.needsContinuation)detail='The previous shot or this direction changed. Continue this beat again to use the current shot.';
 else if(track.job&&!track.matches)detail='Your direction changed. Regenerate this beat to include the edits.';
 else detail=track.ready?'This beat is ready to preview and export.':'Generate this beat to create its footage.';
 const slow=seconds!==undefined&&seconds>=60&&track.job?.status==='generating'?'Still waiting on the model. Status is checked every few seconds; you can switch tabs while it runs.':undefined;
 return {status,detail,elapsed,slow};
}
