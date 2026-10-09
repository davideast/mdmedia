import {createGeminiClient} from 'mdmedia/tts';
import {verifyIdToken} from '@/lib/firebase-admin';
import {readVideoJson,VideoRequestError} from '@/lib/video-generation';
import {readVideoBrief} from '@/lib/video-script';
import {readSourcePreview} from '@/lib/video-source-server';
import {VIDEO_SCRIPT_INSTRUCTION,VIDEO_SCRIPT_SCHEMA,scriptRequestText,draftValidatedScript} from '@/lib/video-script-planner';
export const runtime='nodejs';
export const maxDuration=120;
export async function POST(request:Request){
  const uid=await verifyIdToken(request.headers.get('authorization'));
  if(!uid)return Response.json({message:'Please sign in to draft a video.'},{status:401});
  if(!process.env.GEMINI_API_KEY)return Response.json({message:'Script drafting needs the server Gemini API key.'},{status:503});
  try{
    const brief=readVideoBrief(await readVideoJson(request));
    if(!brief||!brief.prompt.trim())throw new VideoRequestError('Describe the video you want to make.');
    if(brief.continuity==='continuous'&&brief.targetSeconds>40)throw new VideoRequestError('One continuous shot currently supports up to 40 seconds. Shorten the target or choose Planned cuts.');
    const parts:({text:string}|{inlineData:{mimeType:string;data:string}})[]=[];
    if(brief.source){
      const {source,bytes}=await readSourcePreview(uid,brief.source.id);
      if(brief.sourceOut>source.durationSeconds+.025||brief.sourceOut-brief.sourceIn<.1)throw new VideoRequestError('Choose an opening range inside the source video.');
      if(bytes.length>18*1024*1024)throw new VideoRequestError('Use a shorter reference for script analysis (preview must be under 18 MB).');
      brief.source=source;
      parts.push({inlineData:{mimeType:'video/mp4',data:bytes.toString('base64')}});
    }
    parts.push({text:scriptRequestText(brief)+'\nWhen analyzing the reference, transcribe and describe ONLY the selected time range. Footage outside that range provides context, not opening dialogue.'});
    const signal=AbortSignal.timeout(100000);
    const client=createGeminiClient();
    let script;
    try {
      script=await draftValidatedScript(brief,async repair=>{
        const response=await client.models.generateContent({
          model:process.env.GEMINI_SCRIPT_MODEL?.trim()||'gemini-3.5-flash-lite',
          contents:[{role:'user',parts:[...parts,...(repair?[{text:JSON.stringify({previousDraft:repair.previous,correction:repair.problem,instruction:'Rewrite the complete script to resolve these issues. Develop the story to fill the target; do not just pad durations. Keep reference intent and all production distinctions.'})}]:[])]}],
          config:{systemInstruction:VIDEO_SCRIPT_INSTRUCTION,responseMimeType:'application/json',responseJsonSchema:VIDEO_SCRIPT_SCHEMA,abortSignal:signal},
        });
        try{return JSON.parse(response.text??'');}catch{throw new VideoRequestError('The script response could not be read. Your current script is saved; try again.',502);}
      });
    }catch(error){if(error instanceof VideoRequestError)throw error;throw new VideoRequestError(error instanceof Error&&error.message.startsWith('The draft still')?error.message:'Script drafting could not finish. Your current script is saved; try again.',502);}
    return Response.json({script},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return Response.json({message:error instanceof VideoRequestError?error.message:'Script drafting could not finish. Your brief is saved; try again.'},{status:error instanceof VideoRequestError?error.status:503});}
}
