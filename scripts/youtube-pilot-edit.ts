// Assemble a 30s editorial proof from generated media and actual CLI transcripts.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const dir=path.resolve('.design/youtube-pilot');
const ff=path.resolve('studio/node_modules/ffmpeg-static/ffmpeg');
const mono='/System/Library/Fonts/Menlo.ttc';
const sans='/System/Library/Fonts/Supplemental/Arial Bold.ttf';
await mkdir(`${dir}/edit`,{recursive:true});
function run(args:string[]){const p=spawnSync(ff,['-y','-hide_banner','-loglevel','error','-nostdin',...args],{maxBuffer:4e6});if(p.status!==0)throw Error(p.stderr.toString());}
function wrap(text:string,n:number){return text.split('\n').flatMap(line=>{const rows:string[]=[];while(line.length>n){let at=line.lastIndexOf(' ',n);if(at<1)at=n;rows.push(line.slice(0,at));line=line.slice(at).trimStart();}return [...rows,line];}).join('\n');}
async function txt(name:string,text:string){const file=`${dir}/edit/${name}.txt`;await writeFile(file,text);return file;}
function draw(file:string,x:string|number,y:string|number,size:number,color='white',extra=''){return `drawtext=fontfile='${mono}':textfile='${file}':expansion=none:x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}:line_spacing=9${extra}`;}
const codec=['-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-an'];
for(const kind of ['image','video','music']){
 const log=JSON.parse(await readFile(`${dir}/${kind}-command.json`,'utf8'));
 if(log.exitCode!==0)throw Error(`${kind} run did not succeed`);
 // Display the real invocation. Long prompt text is wrapped, not invented.
 const args=log.args.map((a:string)=>/\s/.test(a)?JSON.stringify(a):a).join(' ');
 const command=await txt(`${kind}-cmd`,wrap(`$ ${log.executable} ${args}`,91));
 const focus=await txt(`${kind}-focus`,`mdmedia ${kind}`);
 const title=await txt(`${kind}-title`,{image:'01 / CREATE THE IMAGE',video:'02 / MAKE IT MOVE',music:'03 / GIVE IT A SCORE'}[kind]!);
 const output=await txt(`${kind}-output`,wrap(log.output.replace(/\x1b\[[0-9;]*m/g,'').replace(/[\u{1F300}-\u{1FAFF}\u2705]/gu,'').split('\n').filter((line:string)=>/Success|Saved generated/.test(line)).join('\n').trim(),93));
 const footer=await txt(`${kind}-footer`,'Actual CLI run / waiting time removed');
 const filter=[`drawbox=x=42:y=38:w=1196:h=644:color=0x1b1d20:t=fill`,`drawbox=x=42:y=112:w=1196:h=2:color=0x3d4145:t=fill`,draw(title,72,66,24),draw(focus,72,142,54),draw(command,72,235,19,'0xc0c6ce'),draw(output,72,550,18,'0xeeeeee',":enable='gte(t,0.65)'"),draw(footer,72,647,15,'0x969da5')].join(',');
 run(['-f','lavfi','-i','color=c=0x0d0f11:s=1280x720:r=24','-t','4','-vf',filter,...codec,`${dir}/edit/terminal-${kind}.mp4`]);
}
// Shot timings deliberately separate spoken passages from picture changes.
const shots=[
 {start:0,end:2.4,source:'launch.mp4',in:2.5,label:'MADE IN A TERMINAL'},
 {start:2.4,end:3.1,source:'edit/terminal-image.mp4',in:0},
 {start:3.1,end:6.5,source:'presenter-3.mp4',in:3.1,punch:true},
 {start:6.5,end:8.7,source:'edit/terminal-image.mp4',in:0},
 {start:8.7,end:10,source:'ship.png',in:0},
 {start:10,end:11.8,source:'edit/terminal-video.mp4',in:0},
 {start:11.8,end:14.2,source:'launch.mp4',in:0},
 {start:14.2,end:16.8,source:'edit/terminal-music.mp4',in:0},
 {start:16.8,end:19.3,source:'launch.mp4',in:3,label:'A VERY REASONABLE BUDGET'},
 {start:19.3,end:20,source:'launch.mp4',in:5.5},
 {start:20,end:21.6,source:'presenter-3.mp4',in:20,punch:true},
 {start:21.6,end:26,source:'launch.mp4',in:2},
 {start:26,end:28.4,source:'presenter-3.mp4',in:26,label:'IMAGE → VIDEO → MUSIC'},
 {start:28.4,end:29.2,source:'ship.png',in:0,label:'IMAGE → VIDEO → MUSIC'},
 {start:29.2,end:30,source:'launch.mp4',in:5,label:'IMAGE → VIDEO → MUSIC'},
];
await writeFile(`${dir}/edit-decision-list.json`,JSON.stringify(shots,null,2));
for(let i=0;i<shots.length;i++){
 const s=shots[i];const duration=s.end-s.start;
 const still=s.source.endsWith('.png');
 const scale=s.punch?'scale=1440:810,crop=1280:720:80:35':'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720';
 const filters=[scale,'setsar=1','fps=24'];
 if(s.label){const file=await txt(`label-${i}`,s.label);filters.push(`drawbox=x=50:y=596:w=1180:h=75:color=black@0.65:t=fill`,draw(file,75,615,30));}
 run([...(still?['-loop','1']:['-ss',String(s.in)]),'-i',`${dir}/${s.source}`,'-t',String(duration),'-vf',filters.join(','),...codec,`${dir}/edit/shot-${i}.mp4`]);
}
await writeFile(`${dir}/edit/concat.txt`,shots.map((_,i)=>`file '${dir}/edit/shot-${i}.mp4'`).join('\n'));
run(['-f','concat','-safe','0','-i',`${dir}/edit/concat.txt`,'-c','copy',`${dir}/edit/picture.mp4`]);
// The comic squeak is an editorial synthetic effect, not an mdmedia CLI claim.
run(['-f','lavfi','-i',"aevalsrc=0.20*sin(2*PI*(950*t+900*t*t))*sin(PI*t/0.35):s=48000:d=0.35",`${dir}/edit/squeak.wav`]);
const mix=[
 '[1:a]atrim=0:30,asetpts=PTS-STARTPTS,volume=1[voice]',
 "[2:a]atrim=0:30,asetpts=PTS-STARTPTS,volume='if(lt(t,2.4),0.22,if(between(t,16.8,19.3),0.55,if(between(t,21.6,26),0.5,if(gte(t,28.4),0.4,0))))':eval=frame,afade=t=out:st=29:d=1[music]",
 "[3:a]atrim=0:30,asetpts=PTS-STARTPTS,volume='if(lt(t,2.4),0.16,if(between(t,11.8,14.2),0.14,if(between(t,21.6,26),0.28,0)))':eval=frame[engine]",
 '[4:a]adelay=19300|19300[squeak]',
 '[voice][music][engine][squeak]amix=inputs=4:duration=first:normalize=0,alimiter=limit=0.94:level=false[audio]',
].join(';');
run(['-i',`${dir}/edit/picture.mp4`,'-i',`${dir}/presenter-3.mp4`,'-stream_loop','-1','-i',`${dir}/score.mp3`,'-stream_loop','-1','-i',`${dir}/launch.mp4`,'-i',`${dir}/edit/squeak.wav`,'-filter_complex',mix,'-map','0:v','-map','[audio]','-t','30','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',`${dir}/terminal-hollywood-opening.mp4`]);
console.log(`Saved ${dir}/terminal-hollywood-opening.mp4`);
