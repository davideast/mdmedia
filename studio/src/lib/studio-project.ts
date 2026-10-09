import type {ProjectImport} from '../../../src/projects/index';
import {readVideoScript, shotTiming} from './video-script';
import {buildScriptTimeline} from './script-timeline';
import type {SceneDraftRecord} from './video-generation';
export const isProjectId = (id: string) => /^[a-z0-9][a-z0-9-]{0,59}$/.test(id);
function text(value: unknown, max: number, label: string): string {
  if(typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}.`);
  return value;
}
/** Canonical, bounded import. Ignores caller-owned fields such as uid, jobs and media IDs. */
export function readProjectImport(value: unknown): ProjectImport {
  if(!value || typeof value !== 'object') throw new Error('Expected a project manifest.');
  const input = value as Record<string, unknown>;
  if(input.version !== 1 || typeof input.id !== 'string' || !isProjectId(input.id)) throw new Error('Use a version 1 manifest and a lowercase project id.');
  if(!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 12) throw new Error('A project needs 1–12 parts.');
  if(!Array.isArray(input.reviewNotes) || input.reviewNotes.length > 20) throw new Error('Use at most 20 review notes.');
  const ids = new Set<string>();
  const parts: ProjectImport['parts'] = input.parts.map((raw): ProjectImport['parts'][number] => {
    if(!raw || typeof raw !== 'object') throw new Error('Invalid project part.');
    const part = raw as Record<string, unknown>;
    if(typeof part.id !== 'string' || !isProjectId(part.id) || part.id.length > 30 || ids.has(part.id)) throw new Error('Parts need unique lowercase ids, at most 30 characters.');
    ids.add(part.id);
    if(part.continuity !== 'continuous' && part.continuity !== 'planned') throw new Error('Choose continuity for every part.');
    const parsed = readVideoScript(part.script);
    if(!parsed || parsed.shots.some(shot => shot.source === 'original')) throw new Error(`Invalid script for ${part.id}. Imported footage must be attached in Studio.`);
    if(parsed.shots.reduce((sum, shot) => sum + shot.seconds, 0) > 180) throw new Error(`Split ${part.id} into parts of at most 180 seconds.`);
    const shots = parsed.shots.map(shot => ({id:shot.id,title:shot.title,seconds:shot.seconds,source:shot.source as 'generated'|'presenter'|'screencast',connection:shot.connection,dialogue:shot.dialogue,visual:shot.visual,audio:shot.audio,...(shot.pauseSeconds !== undefined ? {pauseSeconds:shot.pauseSeconds} : {})}));
    return {id:part.id,continuity:part.continuity,script:{title:parsed.title,sourceTranscript:parsed.sourceTranscript,sourceDescription:parsed.sourceDescription,shots}};
  });
  return {version:1,id:input.id,title:text(input.title,150,'project title'),productionNotes:text(input.productionNotes,6000,'production notes'),reviewNotes:input.reviewNotes.map(note=>text(note,1000,'review note')),parts};
}
export function projectDrafts(project: ProjectImport): {id:string;record:SceneDraftRecord}[] {
  return project.parts.map(part => {
    const script = part.script;
    const targetSeconds = script.shots.reduce((sum,shot)=>sum+shot.seconds,0);
    if(targetSeconds < 10) throw new Error('Each part needs at least 10 seconds.');
    const prompt = `Imported screenplay: ${project.title}\n\n${project.productionNotes}`;
    const videoBrief = {prompt,targetSeconds,sourceIn:0,sourceOut:0,sourceUsage:'reference' as const,submittedSourceUsage:'reference' as const,submittedSource:'',submittedRange:'0:0',continuity:part.continuity,script,submittedPrompt:prompt,submittedTarget:targetSeconds};
    const record = buildScriptTimeline({videoBrief,draft:{mode:'text',frame:'16:9',note:project.productionNotes,beats:[]}},script);
    return {id:`${project.id}__${part.id}`,record};
  });
}
export function projectReviewNotes(project: ProjectImport): string[] {
  const timing = project.parts.flatMap(part=>part.script.shots.filter(shot=>shotTiming(shot).rushed).map(shot=>`${part.script.title} / ${shot.title}: allow more time for dialogue and reactions.`));
  return [...project.reviewNotes,...timing];
}
