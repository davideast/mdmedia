import {adminDb,verifyIdToken} from '@/lib/firebase-admin';
import {readVideoJson} from '@/lib/video-generation';
import {readVideoPlanSnapshot} from '@/lib/video-plan-snapshot';
export const runtime='nodejs';
export async function PUT(request:Request,context:{params:Promise<{id:string}>}){
  const uid=await verifyIdToken(request.headers.get('authorization'));
  if(!uid)return Response.json({message:'Please sign in to save the video plan.'},{status:401});
  const {id}=await context.params;
  if(!/^[\w-]{1,100}$/.test(id))return Response.json({message:'Invalid video document.'},{status:400});
  let plan;
  try{plan=readVideoPlanSnapshot(await readVideoJson(request));}
  catch{return Response.json({message:'The video plan could not be read.'},{status:400});}
  try{
    await adminDb().collection('videos').doc(uid).collection('plans').doc(id).set({...plan,ownerUid:uid,updatedAt:Date.now()});
    return Response.json({saved:true});
  }catch{return Response.json({message:'Could not save the video plan. No generation was started; try again.'},{status:503});}
}
