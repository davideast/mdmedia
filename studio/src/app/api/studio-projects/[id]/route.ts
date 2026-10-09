import {restoreVideoPlan} from '@/lib/video-plan-snapshot';
import {adminDb,verifyIdToken} from '@/lib/firebase-admin';
import {isProjectId,readProjectImport,projectDrafts,projectReviewNotes} from '@/lib/studio-project';
export const runtime='nodejs';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  const uid=await verifyIdToken(request.headers.get('authorization'));
  if(!uid)return Response.json({message:'Please sign in to view the project.'},{status:401});
  const {id}=await context.params;
  if(!isProjectId(id))return Response.json({message:'Invalid project id.'},{status:400});
  try{
    const doc=await adminDb().collection('videos').doc(uid).collection('projects').doc(id).get();
    if(!doc.exists)return Response.json({message:'Project not found in this account.'},{status:404});
    const project=readProjectImport(doc.data()?.manifest);
    const drafts=await Promise.all(projectDrafts(project).map(async draft=>{
      const saved=await adminDb().collection('videos').doc(uid).collection('plans').doc(draft.id).get();
      const record=saved.data()?.ownerUid===uid?restoreVideoPlan(saved.data()):null;
      return {...draft,record:record??draft.record};
    }));
    return Response.json({project,drafts,reviewNotes:projectReviewNotes(project)});
  }catch{return Response.json({message:'Could not load the project.'},{status:503});}
}
