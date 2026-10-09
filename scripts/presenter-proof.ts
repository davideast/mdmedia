/** Isolated provider experiment. Does not modify Studio projects or generation jobs.
 * bun --env-file=studio/.env scripts/presenter-proof.ts first|continue|review
 * Outputs and resumable interaction IDs live in /private/tmp/mdmedia-presenter-proof.
 */
import {mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {createGeminiClient} from '../src/tts/gemini-client-factory';
import {GeminiOmniVideoProvider} from '../src/video/gemini-omni-video-provider';
import {readMp4Duration} from '../src/video/mp4-duration';

const folder='/private/tmp/mdmedia-presenter-proof';
await mkdir(folder,{recursive:true});
const client=createGeminiClient();
const mode=process.argv[2];
const model='gemini-omni-1.1-flash';
const firstLine='I gave my terminal a Hollywood budget. Images, video, music, sound effects. The terminal has an agent now.';
const secondLine='Today, we are using M D media to make the whole thing. If this works, my keyboard gets executive producer credit.';
const firstPrompt=`[# References <VIDEO_REF_0>@Video1] Generate a NEW 10-second photorealistic YouTube presenter shot featuring the same adult man in <VIDEO_REF_0>. Preserve his facial features, hair, clothing, desk, microphone, laptop, room and camera framing. Use the video as a character and setting reference, not as a source for video editing or extension. One continuous shot, no cuts. He looks toward the camera, speaks with warm dry humor, subtle natural gestures and realistic synchronized mouth movements. He says exactly: "${firstLine}" A tiny comedic pause before the last sentence. Conversational adult male American English voice, clean close microphone sound, no music, no captions, no other speakers. Finish the whole line within ten seconds. Do not repeat the reference recording's words.`;
const continuationPrompt=`Extend this video with ten more seconds, continuing the same unbroken presenter shot. Preserve the same man's identity, clothing, room, framing, lighting and the same speaking voice. Continue naturally after his previous sentence without repeating it. He says exactly: "${secondLine}" Playful understated delivery, a small amused smile on executive producer credit. Natural synchronized mouth movements, no music or captions, no cut or fade. Finish this new line within the ten-second extension.`;
const manifestPath=`${folder}/manifest.json`;
if(mode==='first') {
  try{await access(manifestPath);throw new Error('First result already exists. Use continue or review; do not accidentally resubmit.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const reference=await readFile('/private/tmp/mdmedia-presenter-reference.mp4');
  await writeFile(`${folder}/prompts.json`,JSON.stringify({model,firstLine,secondLine,firstPrompt,continuationPrompt},null,2));
  console.log('Generating reference-based presenter, 10 seconds. Reference audio is not used.');
  const startedAt=Date.now();
  const interaction=await client.interactions.create({model,store:true,input:[{type:'video',data:reference.toString('base64'),mime_type:'video/mp4'},{type:'text',text:firstPrompt}],response_format:{type:'video',duration:'10s',aspect_ratio:'16:9',delivery:'inline'}} as any,{signal:AbortSignal.timeout(600000)});
  const response=interaction as any;
  const output=response.output_video??response.steps?.filter((s:any)=>s.type==='model_output').flatMap((s:any)=>s.content??[]).find((c:any)=>c.type==='video');
  if(!output?.data)throw new Error(`No inline video returned (${response.status}).`);
  const bytes=Buffer.from(output.data,'base64');
  await writeFile(`${folder}/01-presenter.mp4`,bytes);
  const manifest={model,first:{interactionId:response.id,duration:readMp4Duration(bytes),elapsedSeconds:(Date.now()-startedAt)/1000}};
  await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({saved:`${folder}/01-presenter.mp4`,...manifest.first}));
}else if(mode==='continue') {
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.continuation)throw new Error('Continuation already exists; use review.');
  console.log('Extending generated presenter with the second line, 10 more seconds.');
  const startedAt=Date.now();
  const result=await new GeminiOmniVideoProvider(client,0,model).generateVideoClip(continuationPrompt,{previousInteractionId:manifest.first.interactionId,durationSeconds:10,aspectRatio:'16:9',delivery:'inline',timeoutMs:600000});
  await writeFile(`${folder}/02-continuous-presenter.mp4`,result.videoBytes);
  manifest.continuation={interactionId:result.interactionId,duration:result.durationSeconds,elapsedSeconds:(Date.now()-startedAt)/1000};
  await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({saved:`${folder}/02-continuous-presenter.mp4`,...manifest.continuation}));
}else if(mode==='review') {
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const filename=manifest.continuation?'02-continuous-presenter.mp4':'01-presenter.mp4';
  const [reference,video]=await Promise.all([readFile('/private/tmp/mdmedia-presenter-reference.mp4'),readFile(`${folder}/${filename}`)]);
  const result=await client.models.generateContent({model:process.env.GEMINI_SCRIPT_MODEL||'gemini-3.5-flash-lite',contents:[{role:'user',parts:[{text:'First video: original reference. Second video: generated presenter proof.'},{inlineData:{mimeType:'video/mp4',data:reference.toString('base64')}},{inlineData:{mimeType:'video/mp4',data:video.toString('base64')}},{text:`Critically inspect the generated second video. Return JSON: actualTranscript (only words heard), identityConsistency (visible similarity to reference, no identification), lipSync, motionArtifacts, voiceContinuity (within generated video), boundaryAtTenSeconds, verdict, limitations. Expected generated speech: ${firstLine} ${manifest.continuation?secondLine:''}. Report omissions, repetitions and abrupt visual or audio changes. Do not claim voice matching to reference. Be specific; distinguish observed issues from uncertainty.`}]}],config:{responseMimeType:'application/json',abortSignal:AbortSignal.timeout(120000)}});
  await writeFile(`${folder}/model-review.json`,result.text??'{}');
  console.log(result.text);
}else throw new Error('Choose first, continue, or review.');
