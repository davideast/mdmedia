/** Offline production compiler. Does not submit generation requests or resolve assets. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface ProductionPlan {
  version: 1;
  title: string;
  screenplay: { path: string; sha256: string };
  duration: number;
  rules: string[];
  setting: string;
  characters: Record<string, { identity: string; voice: string; silent: boolean; reference: string }>;
  assets: Record<string, { purpose: string; path: string | null }>;
  dialogue: { id: string; speaker: string; text: string; start: number; end: number; delivery: string; production: 'native' | 'editorial' }[];
  shots: {
    id: string; title: string; start: number; end: number;
    connection: 'opening' | 'cut' | 'continue'; previousShotId: string | null;
    visibleCharacters: Record<string, string>;
    referenceAssets: string[]; referenceFrames: { shotId: string; purpose: string }[];
    startState: string; endState: string; camera: string;
    actionCues: { start: number; end: number; action: string }[];
    dialogueCues: { dialogueId: string; visibility: 'on-camera' | 'offscreen' }[];
    sound: string; transition: string;
  }[];
}

export function validatePlan(plan: ProductionPlan) {
  const fail = (message: string): never => { throw new Error(message); };
  const finite = (n: number) => Number.isFinite(n);
  if (plan.version !== 1 || !finite(plan.duration) || plan.duration <= 0 || !plan.shots.length) fail('Invalid plan header');
  const ids = new Set<string>(), lines = new Map(plan.dialogue.map(d => [d.id, d]));
  if (lines.size !== plan.dialogue.length) fail('Duplicate dialogue ID');
  let end = 0, chain = 0;
  for (const [index, shot] of plan.shots.entries()) {
    if (!/^[a-z0-9_-]+$/.test(shot.id) || ids.has(shot.id)) fail('Invalid or duplicate shot ID');
    if (!finite(shot.start) || !finite(shot.end) || shot.start !== end || shot.end-shot.start < 3 || shot.end-shot.start > 10) fail(`Invalid timing: ${shot.id}`);
    if (shot.connection !== (index === 0 ? 'opening' : shot.connection) || (index > 0 && shot.connection === 'opening')) fail(`Invalid opening: ${shot.id}`);
    if (shot.previousShotId !== (index ? plan.shots[index-1].id : null)) fail(`Broken predecessor: ${shot.id}`);
    chain = shot.connection === 'continue' ? chain + shot.end-shot.start : shot.end-shot.start;
    if (chain > 40) fail(`Continuation chain exceeds current supported plan limit: ${shot.id}`);
    for (const actor of Object.keys(shot.visibleCharacters)) if (!plan.characters[actor]) fail(`Unknown visible actor ${actor}`);
    for (const asset of shot.referenceAssets) if (!plan.assets[asset]) fail(`Unknown asset ${asset}`);
    for (const frame of shot.referenceFrames) if (!ids.has(frame.shotId)) fail(`Reference must precede shot: ${shot.id}`);
    for (const cue of shot.actionCues) if (!finite(cue.start) || !finite(cue.end) || cue.start < shot.start || cue.end > shot.end || cue.end <= cue.start) fail(`Action outside shot: ${shot.id}`);
    if (new Set(shot.dialogueCues.map(c => c.dialogueId)).size !== shot.dialogueCues.length) fail(`Duplicate cue: ${shot.id}`);
    for (const cue of shot.dialogueCues) {
      const line = lines.get(cue.dialogueId);
      if (!line || line.start >= shot.end || line.end <= shot.start) fail(`Dialogue outside shot: ${shot.id}`);
      if (cue.visibility === 'on-camera' && !shot.visibleCharacters[line!.speaker]) fail(`Speaker absent from shot: ${shot.id}`);
    }
    ids.add(shot.id); end = shot.end;
  }
  if (end !== plan.duration) fail('Timeline does not match target duration');
  for (const line of plan.dialogue) {
    const actor = plan.characters[line.speaker];
    if (!actor || actor.silent) fail(`Invalid speaking role: ${line.speaker}`);
    if (!finite(line.start) || !finite(line.end) || line.start < 0 || line.end > end || line.end <= line.start || !line.text.trim()) fail(`Invalid dialogue: ${line.id}`);
    const overlapping = plan.shots.filter(s => line.start < s.end && line.end > s.start);
    if (overlapping.some(s => !s.dialogueCues.some(c => c.dialogueId === line.id))) fail(`Missing dialogue coverage: ${line.id}`);
    if (line.production === 'native' && overlapping.length !== 1) fail(`Cross-cut speech must be one editorial asset: ${line.id}`);
    for (const other of plan.dialogue) if (other.id !== line.id && other.start < line.end && other.end > line.start) fail(`Overlapping speakers: ${line.id}/${other.id}`);
  }
}

export function compilePlan(plan: ProductionPlan) {
  validatePlan(plan);
  const requests = plan.shots.map(shot => {
    const duration = shot.end-shot.start;
    const local = (time: number) => Math.round((time-shot.start)*1000)/1000;
    const cues = shot.dialogueCues.map(cue => ({ ...cue, line: plan.dialogue.find(d => d.id === cue.dialogueId)! }));
    const cast = [...new Set([...Object.keys(shot.visibleCharacters), ...cues.map(c => c.line.speaker)])];
    const native = cues.filter(c => c.line.production === 'native');
    const editorial = cues.filter(c => c.line.production === 'editorial');
    const prompt = [
      `${shot.connection === 'continue' ? `Extend the attached previous video by ${duration} seconds` : `Generate one camera shot lasting ${duration} seconds`}. All times below are seconds within this new segment.`,
      shot.connection === 'continue' ? `Continue the actual ending of ${shot.previousShotId}. Preserve camera motion, voices, character identities and action. Perform only the NEW cues below; never repeat the previous dialogue or replay the beginning.` : 'Use the supplied character and location references. Render a single scene, never a reference-sheet lineup. The editor places the hard cut; do not generate a transition or additional angles.',
      'SHARED RULES\n'+plan.rules.join('\n'),
      'LOCATION\n'+plan.setting,
      'CHARACTER IDENTITIES\n'+cast.map(id => `${id}: ${plan.characters[id].identity} Voice: ${plan.characters[id].voice}`).join('\n'),
      'VISIBLE CAST — only these characters may appear\n'+Object.entries(shot.visibleCharacters).map(([id,position]) => `${id}: ${position}`).join('\n'),
      'OPENING STATE\n'+shot.startState,
      'CAMERA\n'+shot.camera,
      'ACTION\n'+shot.actionCues.map(c => `${local(c.start)}–${local(c.end)}s: ${c.action}`).join('\n'),
      native.length ? 'GENERATED DIALOGUE — speak only these exact lines\n'+native.map(({line,visibility}) => `${local(line.start)}–${local(line.end)}s: ${line.speaker} ONLY (${visibility}); ${line.delivery}. Says: ${JSON.stringify(line.text)}. All other visible characters remain silent and do not mouth these words.`).join('\n') : 'GENERATED DIALOGUE: None. Generate no spoken words.',
      editorial.length ? 'EDITORIAL AUDIO RESERVATIONS\n'+editorial.map(({line,visibility}) => `${local(Math.max(line.start,shot.start))}–${local(Math.min(line.end,shot.end))}s: reserve for external cue ${line.id}, spoken by ${line.speaker}, ${visibility}. Do NOT synthesize this line in the video audio. ${visibility === 'offscreen' ? 'Visible characters listen silently and turn toward the offscreen voice.' : 'The visible speaker requires synchronization to the separately rendered recording. Final shot acceptance depends on that synchronization pass; prompt text alone does not provide it.'}`).join('\n') : '',
      'SOUND\n'+shot.sound,
      'ENDING STATE\n'+shot.endState,
      'Never speak headings, actor names used as labels, or stage directions. An addressed name inside a quoted line never changes the speaker. Mouth movement belongs only to the active on-camera speaker. No narrator, extra lines, fades or dissolves.'
    ].filter(Boolean).join('\n\n');
    return {
      shotId: shot.id, title: shot.title, timeline: {start:shot.start,end:shot.end}, durationSeconds: duration,
      operation: shot.connection === 'continue' ? 'extend' : 'generate',
      previousInteractionFrom: shot.connection === 'continue' ? shot.previousShotId : null,
      referenceAssets: shot.referenceAssets, referenceFrames: shot.referenceFrames,
      inheritsPreviousState: shot.connection === 'continue',
      editorialConnection: {type:shot.connection,previousShotId:shot.previousShotId,bridge:shot.transition},
      requiredPostproduction: editorial.map(c => ({cueId:c.line.id,visibility:c.visibility,localStart:local(Math.max(c.line.start,shot.start)),localEnd:local(Math.min(c.line.end,shot.end)),sourceIn:Math.max(shot.start-c.line.start,0)})),
      prompt
    };
  });
  return {
    title:plan.title, durationSeconds:plan.duration, source:plan.screenplay,
    submissionStatus:'not-submitted',
    runtimeRequirements:[
      'Resolve character/location asset keys before submission; symbolic keys are not file attachments.',
      'For extensions bind previousInteractionFrom to the actual successful provider interaction ID. Stop on failed or incomplete predecessors; never silently fall back to a new shot.',
      'For cuts extract specified reference frames from accepted footage and attach them with character references.',
      'Current video provider interface has image references and continuation IDs but no voice-reference or audio-input field. Voice descriptions are guidance, not locked voices.',
      'Render each editorial speech cue once. Synchronize visible speaker footage to that recording and mix it across the cut; the existing builder does not yet execute this contract.',
      'Use one continuous ambience/music bed in editorial assembly, without duplicating any native speech.'
    ],
    unresolvedAssets:Object.entries(plan.assets).filter(([,a])=>!a.path).map(([id,a])=>({id,purpose:a.purpose})),
    audioBridges:plan.dialogue.filter(d=>d.production==='editorial').map(d=>({...d,renderCount:1,placements:requests.flatMap(r=>r.requiredPostproduction.filter(c=>c.cueId===d.id).map(c=>({shotId:r.shotId,...c})))})),
    requests
  };
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw Error('Usage: bun scripts/compile-production-plan.ts <plan.json> <output-folder>');
  const plan: ProductionPlan = JSON.parse(await readFile(input,'utf8'));
  const screenplay = await readFile(plan.screenplay.path);
  if (createHash('sha256').update(screenplay).digest('hex') !== plan.screenplay.sha256) throw Error('Screenplay changed: reconcile the structured plan before compiling.');
  const compiled = compilePlan(plan);
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'requests.json'),JSON.stringify(compiled,null,2)+'\n');
  await writeFile(path.join(output,'prompts.md'),`# ${plan.title} — compiled prompts\n\n${compiled.requests.length} segments · ${plan.duration}s · offline compilation only.\n\n`+compiled.requests.map(r=>`## ${r.shotId}: ${r.title} (${r.timeline.start}–${r.timeline.end}s)\n\nConnection: ${r.editorialConnection.type}. ${r.editorialConnection.bridge}\n\nReferences: ${r.referenceAssets.join(', ')}. Prior footage: ${r.referenceFrames.map(f=>f.shotId).join(', ')||r.previousInteractionFrom||'none'}.\n\n${r.prompt}\n`).join('\n---\n\n'));
  console.log(`Compiled ${compiled.requests.length} segments, ${plan.duration}s, ${compiled.audioBridges.length} shared dialogue asset. No generation submitted.`);
}
