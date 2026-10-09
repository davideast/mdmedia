import {readFile,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGeminiClient} from '../../../src/tts/gemini-client-factory';
import {GeminiOmniVideoProvider} from '../../../src/video/gemini-omni-video-provider';

type Job={id:string;kind:'image'|'video';prompt:string;output:string;images?:string[];firstFrame?:string;seconds?:number;previousInteractionId?:string};
const dir='.design/beneath-double-coat/breakfast-exchange';
const [input,...ids]=process.argv.slice(2);
const jobs:Job[]=JSON.parse(await readFile(input,'utf8'));
const client=createGeminiClient();
const provider=new GeminiOmniVideoProvider(client,0,'gemini-omni-1.1-flash');
for(const job of jobs.filter(job=>!ids.length||ids.includes(job.id))){
 const digest=createHash('sha256').update(JSON.stringify(job));
 for(const file of [job.firstFrame,...job.images??[]].filter(Boolean) as string[])digest.update(await readFile(file));
 const fingerprint=digest.digest('hex');
 const receiptPath=`${dir}/${job.id}-receipt.json`;
 try{const old=JSON.parse(await readFile(receiptPath,'utf8'));await access(job.output);if(old.fingerprint===fingerprint){console.log(`${job.id}: retained existing output`);continue;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 console.log(`${job.id}: generating ${job.kind}`);
 if(job.kind==='image'){
  const parts:any[]=[];
  for(const file of job.images??[])parts.push({inlineData:{mimeType:'image/jpeg',data:(await readFile(file)).toString('base64')}});
  parts.push({text:job.prompt});
  const result=await client.models.generateContent({model:'gemini-3.1-flash-image',contents:parts,config:{responseModalities:['IMAGE'],imageConfig:{aspectRatio:'16:9'},abortSignal:AbortSignal.timeout(180000)}});
  const image=result.candidates?.[0]?.content?.parts?.find(part=>part.inlineData)?.inlineData;
  if(!image?.data)throw Error(`${job.id}: provider returned no image`);
  await writeFile(job.output,Buffer.from(image.data,'base64'));
  await writeFile(receiptPath,JSON.stringify({job,fingerprint,mimeType:image.mimeType,review:'pending'},null,2));
 }else{
  const result=await provider.generateVideoClip(job.prompt,{firstFrame:job.firstFrame,referenceImages:job.images,previousInteractionId:job.previousInteractionId,task:job.firstFrame?'image_to_video':undefined,durationSeconds:job.seconds,aspectRatio:'16:9',delivery:'uri',timeoutMs:600000});
  await writeFile(job.output,result.videoBytes);
  await writeFile(receiptPath,JSON.stringify({job,fingerprint,interactionId:result.interactionId,durationSeconds:result.durationSeconds,review:'pending'},null,2),{mode:0o600});
  console.log(`${job.id}: saved ${result.durationSeconds?.toFixed(3)} seconds`);
 }
 console.log(`${job.id}: saved ${job.output}`);
}
