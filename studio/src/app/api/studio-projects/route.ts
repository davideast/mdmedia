import {createHash} from 'node:crypto';
import {adminDb,verifyIdToken} from '@/lib/firebase-admin';
import {readVideoJson,VideoRequestError} from '@/lib/video-generation';
import {readProjectImport,projectDrafts} from '@/lib/studio-project';
export const runtime='nodejs';
export async function GET(request:Request){
  const uid=await verifyIdToken(request.headers.get('authorization'));
  if(!uid)return Response.json({message:'Please sign in to view projects.'},{status:401});
  try{
    const docs=await adminDb().collection('videos').doc(uid).collection('projects').limit(100).get();
    return Response.json({projects:docs.docs.map(doc=>{const p=doc.data();return {id:doc.id,title:p.manifest.title,parts:p.manifest.parts.length,createdAt:p.createdAt};})});
  }catch{return Response.json({message:'Could not load saved projects.'},{status:503});}
}
export async function POST(request:Request){
  const uid=await verifyIdToken(request.headers.get('authorization'));
  if(!uid)return Response.json({message:'Please sign in to import a project.'},{status:401});
  let manifest;
  try{manifest=readProjectImport(await readVideoJson(request));projectDrafts(manifest);}
  catch(error){return Response.json({message:error instanceof Error?error.message:'Invalid project.'},{status:error instanceof VideoRequestError?error.status:400});}
  const hash=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const ref=adminDb().collection('videos').doc(uid).collection('projects').doc(manifest.id);
  const result={id:manifest.id,href:`/projects?import=${manifest.id}`,generationStarted:false};
  try{
    // Transactional create-only also works with the hosted Pyric admin adapter.
    const created=await adminDb().runTransaction(async transaction=>{
      const existing=await transaction.get(ref);
      if(existing.exists){
        if(existing.data()?.hash===hash)return false;
        throw new Error('PROJECT_CONFLICT');
      }
      transaction.set(ref,{manifest,hash,ownerUid:uid,createdAt:Date.now()});
      return true;
    });
    return Response.json({...result,created},{status:created?201:200});
  }catch(error){
    if(error instanceof Error&&error.message==='PROJECT_CONFLICT')return Response.json({message:'This project id already exists with different content. Use a new id to preserve the existing project.'},{status:409});
    if(process.env.NODE_ENV !== 'production')console.warn('[project import] save failed:',error instanceof Error?error.message:'Unknown error');
    return Response.json({message:'Could not save the project. No generation was started.'},{status:503});
  }
}
