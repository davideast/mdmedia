import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { readMp4Duration } from 'mdmedia/video';
import { adminBucket, adminDb } from './firebase-admin';
import { isSourceId, type VideoSource } from './video-script';
import { VideoRequestError } from './video-generation';
const execute = promisify(execFile);
export const sourcePath = (uid: string, id: string, part: 'original' | 'preview' | 'poster') => `video-sources/${uid}/${id}/${part}`;
const sourceRef = (uid: string, id: string) => adminDb().collection('videos').doc(uid).collection('sources').doc(id);
export async function loadVideoSource(uid: string, id: string): Promise<VideoSource | null> {
  if (!isSourceId(id)) return null;
  const doc = await sourceRef(uid, id).get();
  const data = doc.data();
  if (!data || data.ownerUid !== uid) return null;
  return {id, name: data.name, durationSeconds: data.durationSeconds, createdAt: data.createdAt};
}
export async function normalizeVideoSource(bytes: Buffer) {
  if (!ffmpeg) throw new Error('Video processing is unavailable.');
  const directory = await mkdtemp(join(tmpdir(), 'mdmedia-source-'));
  try {
    const input = join(directory, 'input.mov'), output = join(directory, 'preview.mp4'), poster = join(directory, 'poster.jpg');
    const isMov = bytes.length > 12 && bytes.toString('ascii',4,8) === 'ftyp';
    const isWebm = bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
    if(!isMov&&!isWebm)throw new VideoRequestError('The file is not a supported MOV, MP4 or WebM video.');
    await writeFile(input, bytes);
    // Decode only primary picture/audio. iPhone MOVs can contain unsupported spatial audio/data streams.
    await execute(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-f',isMov?'mov':'matroska','-i',input,'-map','0:v:0','-map','0:a:0?','-t','121','-vf',"scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-map_metadata','-1','-movflags','+faststart',output], {timeout:90000,maxBuffer:1024*1024});
    const preview = await readFile(output), durationSeconds = readMp4Duration(preview);
    if (!durationSeconds || durationSeconds > 120) throw new VideoRequestError('Choose a reference video up to two minutes long.');
    await execute(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-i',output,'-frames:v','1','-q:v','3',poster], {timeout:15000,maxBuffer:1024*1024});
    return {preview, poster: await readFile(poster), durationSeconds};
  } finally { await rm(directory, {recursive:true,force:true}); }
}
export async function saveVideoSource(uid: string, file: File): Promise<VideoSource> {
  if (!file.size || file.size > 30*1024*1024 || !/\.(mov|mp4|webm)$/i.test(file.name)) throw new VideoRequestError('Choose a MOV, MP4 or WebM video under 30 MB.');
  const original = Buffer.from(await file.arrayBuffer());
  let processed: Awaited<ReturnType<typeof normalizeVideoSource>>;
  try { processed = await normalizeVideoSource(original); }
  catch(error) { if(error instanceof VideoRequestError) throw error; throw new VideoRequestError('This video could not be decoded. Try an MP4 or another MOV file.'); }
  const id = `s_${crypto.randomUUID().replaceAll('-','')}`;
  const source: VideoSource = {id,name:file.name.slice(0,200),durationSeconds:processed.durationSeconds,createdAt:Date.now()};
  const paths = [sourcePath(uid,id,'original'),sourcePath(uid,id,'preview'),sourcePath(uid,id,'poster')];
  try {
    const writes = await Promise.allSettled([
      adminBucket().file(paths[0]).save(original,{contentType:'application/octet-stream',resumable:false}),
      adminBucket().file(paths[1]).save(processed.preview,{contentType:'video/mp4',resumable:false}),
      adminBucket().file(paths[2]).save(processed.poster,{contentType:'image/jpeg',resumable:false}),
    ]);
    if(writes.some(result=>result.status==='rejected'))throw new Error('Source upload did not finish.');
    await sourceRef(uid,id).set({...source,ownerUid:uid});
    return source;
  } catch(error) { await Promise.allSettled(paths.map(path=>adminBucket().file(path).delete())); throw error; }
}
export async function readSourcePreview(uid: string, id: string) {
  const source = await loadVideoSource(uid,id);
  if (!source) throw new VideoRequestError('That reference video is unavailable.',404);
  const [bytes] = await adminBucket().file(sourcePath(uid,id,'preview')).download();
  return {source,bytes};
}
