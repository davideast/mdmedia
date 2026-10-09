import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readMp4Duration } from 'mdmedia/video';
import type { VideoJob } from './video-generation';
import { coalesceContinuousRanges, exportDuration, type VideoExportRequest } from './video-export';

const execute = promisify(execFile);
export function videoEncoderPath(): string {
  // Resolve the platform binary in the installed package, outside Next's generated chunks.
  const require = createRequire(path.join(process.cwd(),'package.json'));
  const encoder: string | null = process.env.FFMPEG_BIN ?? require('ffmpeg-static');
  if (!encoder) throw new Error('Video export is unavailable on this server.');
  return encoder;
}
export const checkVideoEncoder = () => access(videoEncoderPath(),constants.X_OK);

export interface VideoExportDependencies {
  read: (id:string)=>Promise<Uint8Array>;
  readAudio?:(id:string)=>Promise<Uint8Array>;
  save: (bytes:Uint8Array)=>Promise<void>;
  update: (patch:Partial<VideoJob>)=>Promise<void>;
}
/** Trim, normalize and concatenate only local, owned files. Never performs AI generation. */
export async function runVideoExport(request: VideoExportRequest, dependencies: VideoExportDependencies): Promise<void> {
  let directory: string | undefined;
  const deadline = Date.now()+5*60*1000;
  const run = (args:string[]) => execute(videoEncoderPath(),['-hide_banner','-nostdin',...args],{timeout:Math.max(1,deadline-Date.now()),maxBuffer:2*1024*1024});
  try {
    directory=await mkdtemp(path.join(os.tmpdir(),'mdmedia-export-'));
    const args:string[]=[]; const filters:string[]=[];
    const clips=coalesceContinuousRanges(request.clips);
    const [width,height]=request.frame==='16:9'?[1280,720]:[720,1280]; let totalBytes=0;
    for (let index=0;index<clips.length;index++) {
      const clip=clips[index]; const bytes=await dependencies.read(clip.videoId);
      totalBytes+=bytes.byteLength;
      if (totalBytes>512*1024*1024) throw new Error('Export inputs exceed 512 MB.');
      const filename=path.join(directory,`clip-${index}.mp4`); await writeFile(filename,bytes);
      let hasAudio=false;
      try { await run(['-i',filename]); }
      catch (error) {
        const stderr=error && typeof error==='object' && 'stderr' in error ? String(error.stderr):'';
        if (!stderr.includes('At least one output file must be specified')) throw error;
        hasAudio=/Stream #0:\d+[^\n]*Audio:/.test(stderr);
      }
      // A silent stream is available for clips without audio and for exact tail padding.
      args.push('-i',filename,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000');
      const source=index*2; const length=clip.outSeconds-clip.inSeconds;
      filters.push(`[${source}:v:0]trim=start=${clip.inSeconds}:end=${clip.outSeconds},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,settb=AVTB,format=yuv420p[v${index}]`);
      filters.push(`[${hasAudio?source:source+1}:a:0]atrim=start=${hasAudio?clip.inSeconds:0}:duration=${length},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${clip.muted?0:1},apad=whole_dur=${length},atrim=duration=${length}[a${index}]`);
    }
    let currentVideo='v0',currentAudio='a0',length=clips[0].outSeconds-clips[0].inSeconds;
    for(let index=1;index<clips.length;index++){
      const previous=clips[index-1],clip=clips[index];
      const nextVideo=`joinv${index}`,nextAudio=`joina${index}`;
      if(previous.transition==='fade'){
        const duration=previous.transitionSeconds!;
        filters.push(`[${currentVideo}][v${index}]xfade=transition=fade:duration=${duration}:offset=${length-duration}[${nextVideo}]`);
        filters.push(`[${currentAudio}][a${index}]acrossfade=d=${duration}:c1=tri:c2=tri[${nextAudio}]`);
        length-=duration;
      }else filters.push(`[${currentVideo}][${currentAudio}][v${index}][a${index}]concat=n=2:v=1:a=1[${nextVideo}][${nextAudio}]`);
      length+=clip.outSeconds-clip.inSeconds;currentVideo=nextVideo;currentAudio=nextAudio;
    }
    if(request.audio?.length){
      if(!dependencies.readAudio)throw new Error('Audio sources are unavailable.');
      const labels=[`[${currentAudio}]`];
      for(const [index,audio] of request.audio.entries()){
        const bytes=await dependencies.readAudio(audio.narrationId);totalBytes+=bytes.byteLength;if(totalBytes>512*1024*1024)throw new Error('Export sources exceed 512 MB.');
        const filename=path.join(directory,`audio-${index}.wav`);await writeFile(filename,bytes);args.push('-i',filename);
        const input=clips.length*2+index,label=`placed${index}`;
        filters.push(`[${input}:a:0]atrim=start=${audio.inSeconds}:end=${audio.outSeconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${audio.muted?0:audio.volume},adelay=${Math.round(audio.startSeconds*1000)}:all=1[${label}]`);labels.push(`[${label}]`);
      }
      filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,alimiter=level=false[mixed]`);currentAudio='mixed';
    }
    for(const [index,caption] of (request.captions??[]).entries()){
      // Keep user text out of filter syntax, and disable drawtext's percent expansion.
      const filename=path.join(directory,`caption-${index}.txt`);
      await writeFile(filename,caption.text);
      const label=`captioned${index}`;
      filters.push(`[${currentVideo}]drawtext=textfile='${filename}':expansion=none:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=18:x=48:y=h-th-60:enable='between(t,${caption.start},${caption.end})'[${label}]`);
      currentVideo=label;
    }
    const total=exportDuration(request.clips);
    const output=path.join(directory,'final.mp4');
    await dependencies.update({status:'generating',message:'Joining trimmed clips',updatedAt:Date.now()});
    await run([...args,'-filter_complex',filters.join(';'),'-map',`[${currentVideo}]`,'-map',`[${currentAudio}]`,'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-t',String(total),'-movflags','+faststart','-y',output]);
    const bytes=await readFile(output); const duration=readMp4Duration(bytes);
    if (bytes.byteLength>200*1024*1024 || duration===undefined || Math.abs(duration-total)>0.25) throw new Error('Export duration did not match the selected tracks.');
    await dependencies.update({status:'saving',message:'Saving final video',updatedAt:Date.now()});
    await dependencies.save(bytes);
    await dependencies.update({status:'ready',durationSeconds:duration,message:'Final video ready',updatedAt:Date.now()});
  } catch(error) {
    console.error('[video export] failed:',error instanceof Error?error.message:error);
    await dependencies.update({status:'error',message:'The final video could not be assembled. Your beat clips are saved; check their trims and retry.',updatedAt:Date.now()});
  } finally { if(directory)await rm(directory,{recursive:true,force:true}); }
}
