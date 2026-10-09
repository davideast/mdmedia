// Three ten-second spoken passages; the edit covers most speech with demonstrations.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createGeminiClient} from '../src/tts/gemini-client-factory';
import {GeminiOmniVideoProvider} from '../src/video/gemini-omni-video-provider';
import {readMp4Duration} from '../src/video/mp4-duration';
const dir='.design/youtube-pilot';await mkdir(dir,{recursive:true});
const stage=Number(process.argv[2]);if(![1,2,3].includes(stage))throw Error('Choose stage 1, 2 or 3');
const client=createGeminiClient();
const model='gemini-omni-1.1-flash';
let state:any={};try{state=JSON.parse(await readFile(`${dir}/presenter.json`,'utf8'));}catch{}
if(state[stage])throw Error('Stage already saved; refusing duplicate generation');
const lines=[
 'This came out of my terminal. Apparently, it has a bigger budget than I do. Start with one image.',
 'Make it move. Then give it a wildly unnecessary soundtrack.',
 "Wrong engine. That's better. Three commands. Here's how they fit together.",
];
const timing=[
 'From 0 to 2 seconds say the first sentence, then from 3 to 6 seconds say the budget joke with a wry smile. From 7 to 9 seconds say Start with one image. Let the moments breathe.',
 'From 0 to 2 seconds say Make it move. Pause until 4 seconds, then from 4 to 7 seconds say Then give it a wildly unnecessary soundtrack. Stay silent for the remaining three seconds.',
 "From 0 to 1.3 seconds say Wrong engine with an incredulous raised eyebrow. Pause. At 3 seconds say That's better. Pause until 6 seconds, then say Three commands. Here's how they fit together. Finish by 9.5 seconds.",
];
const prompt=(stage===1?'[# References <VIDEO_REF_0>@Video1] Generate a NEW ten-second YouTube presenter performance of the adult man in <VIDEO_REF_0>. Use the video only as a likeness and setting reference, not as an edit source. Preserve his facial features, clothes, desk, microphone and room.':'Extend the previous generated video with ten more seconds. Keep the exact same presenter, speaking voice, clothes, room, lighting, camera framing and microphone. Do not repeat earlier words.')+` One unbroken shot, locked camera, no music, no captions, no sound effects. Clean natural adult male American English voice and synchronized lip movements. Engaging concise delivery with dry humor. Say exactly: "${lines[stage-1]}" ${timing[stage-1]}`;
console.log(`Generating presenter passage ${stage}/3`);
let bytes:Uint8Array,id:string,duration:number|undefined;
if(stage===1){
 const ref=await readFile('/private/tmp/mdmedia-presenter-reference.mp4');
 const r:any=await client.interactions.create({model,store:true,input:[{type:'video',data:ref.toString('base64'),mime_type:'video/mp4'},{type:'text',text:prompt}],response_format:{type:'video',duration:'10s',aspect_ratio:'16:9',delivery:'inline'}} as any,{signal:AbortSignal.timeout(600000)});
 const out=r.output_video??r.steps?.filter((s:any)=>s.type==='model_output').flatMap((s:any)=>s.content??[]).find((c:any)=>c.type==='video');
 if(!out?.data)throw Error('No generated video');bytes=Buffer.from(out.data,'base64');id=r.id;duration=readMp4Duration(bytes);
}else{
 if(!state[stage-1])throw Error('Previous stage must finish first');
 const r=await new GeminiOmniVideoProvider(client,0,model).generateVideoClip(prompt,{previousInteractionId:state[stage-1].id,durationSeconds:10,delivery:'inline',aspectRatio:'16:9'});
 bytes=r.videoBytes;id=r.interactionId;duration=r.durationSeconds;
}
await writeFile(`${dir}/presenter-${stage}.mp4`,bytes);
state[stage]={id,duration,prompt,line:lines[stage-1]};await writeFile(`${dir}/presenter.json`,JSON.stringify(state,null,2));
console.log(JSON.stringify({stage,duration,saved:`${dir}/presenter-${stage}.mp4`}));
