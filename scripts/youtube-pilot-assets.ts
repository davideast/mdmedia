// Run real CLI commands and preserve their output for the edited terminal demo.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
const dir=path.resolve('.design/youtube-pilot');
await mkdir(dir,{recursive:true});
const kind=process.argv[2];
const specs={
 image:{args:['image','-p','An absurdly expensive cinematic science fiction film still. A sleek silver spaceship poised for launch above a colossal launch platform on a distant desert planet, bright cyan engines, billowing orange dust, tiny human silhouettes for scale, dramatic golden sunlight, photoreal practical model detail, wide dynamic composition, no words or logos.','-o',`${dir}/ship.png`,'--aspect','16:9'],file:'ship.png'},
 video:{args:['video','-i',`${dir}/launch.md`,'--firstFrame',`${dir}/ship.png`,'--task','image_to_video','--model','gemini-omni-1.1-flash','-o',`${dir}/launch.mp4`,'--maxRetries','0'],file:'launch.mp4'},
 music:{args:['music','-p','Instrumental cinematic spaceship launch score. Immediate massive orchestral brass hit and deep percussion, then driving heroic strings, rising tension, triumphant brass payoff. Exaggerated blockbuster trailer energy with a playful swagger. No vocals. Thirty seconds.','--clip','-o',`${dir}/score.mp3`,'--maxRetries','0'],file:'score.mp3'},
};
const spec=specs[kind as keyof typeof specs];if(!spec)throw Error('Choose image, video or music');
try{await access(`${dir}/${spec.file}`);throw Error('Asset already exists; refusing a duplicate paid request');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
if(kind==='video')await writeFile(`${dir}/launch.md`,'A continuous eight-second cinematic spaceship launch, starting exactly from the supplied image. The huge silver ship rises with cyan engines and an enormous cloud of dust, then accelerates into the sky as the camera tracks upward. Awe-inspiring scale, photoreal blockbuster visuals. Sound: deep powerful engine ignition, rising rocket roar and turbulent air. No speech, no music, no captions.');
const started=Date.now();let output='';
console.log(`Running real mdmedia ${kind} command`);
const child=spawn('bun',['--env-file=studio/.env','src/bin.ts',...spec.args],{cwd:process.cwd(),env:process.env});
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b.toString();process.stdout.write(b);});
const code=await new Promise<number|null>(resolve=>child.on('close',resolve));
await writeFile(`${dir}/${kind}-command.json`,JSON.stringify({executable:'bun --env-file=studio/.env src/bin.ts',args:spec.args,output,exitCode:code,elapsedSeconds:(Date.now()-started)/1000},null,2));
if(code!==0)process.exit(code??1);
