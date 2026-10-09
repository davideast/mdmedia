import { expect,it } from 'bun:test';
import { beatGenerationFeedback } from '../../studio/src/lib/scene-generation-feedback';
import type { VideoJob } from '../../studio/src/lib/video-generation';
const job:VideoJob={id:'test',status:'ready',message:'',model:'test',mode:'text',frame:'16:9',createdAt:1000,updatedAt:2000};
const ready={job,busy:false,ready:true,matches:true,needsContinuation:false};
it('shows a blocked continuation instead of hiding feedback behind the completed job’s empty message',()=>{
 const feedback=beatGenerationFeedback({...ready,ready:false,matches:false,needsContinuation:true,continuationIssue:'Restore the previous beat’s original ending to continue it.'},10000);
 expect(feedback.status).toBe('Needs continuation');expect(feedback.detail).toContain('Not generating.');expect(feedback.detail).toContain('original ending');expect(feedback.elapsed).toBeUndefined();
});
it('reports real generation and saving stages, elapsed time and slow model feedback without invented progress',()=>{
 const generating=beatGenerationFeedback({...ready,busy:true,ready:false,job:{...job,status:'generating',message:'Continuing shot 3–6s'}},121000);
 expect(generating.status).toBe('Generating');expect(generating.detail).toBe('Continuing shot 3–6s');expect(generating.elapsed).toBe('2:00 elapsed');expect(generating.slow).toContain('Still waiting');
 const saving=beatGenerationFeedback({...ready,busy:true,job:{...job,status:'saving'}},5100);expect(saving.status).toBe('Saving');expect(saving.detail).toContain('Saving');
});
it('distinguishes an uncertain submission and a failed status read from a confirmed generation',()=>{
 const checking=beatGenerationFeedback({...ready,job:undefined,busy:true,unresolved:true},5000);expect(checking.status).toBe('Checking status');expect(checking.detail).toContain('No new generation');
 const failed=beatGenerationFeedback({...ready,busy:true,issue:'Status could not be reached'},5000);expect(failed.status).toBe('Check status');expect(failed.elapsed).toBeUndefined();
});
