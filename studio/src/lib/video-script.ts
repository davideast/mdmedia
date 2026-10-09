/** Creative intent is separate from footage, generation jobs and timeline edits. */
export interface VideoSource {
  id: string;
  name: string;
  durationSeconds: number;
  createdAt: number;
}
export type ShotSource = 'original' | 'presenter' | 'screencast' | 'generated';
export interface ScriptShot {
  id: string;
  title: string;
  seconds: number;
  source: ShotSource;
  connection: 'cut' | 'continue';
  dialogue: string;
  visual: string;
  audio: string;
  pauseSeconds?: number;
}
export interface VideoScript {
  title: string;
  sourceTranscript: string;
  sourceDescription: string;
  shots: ScriptShot[];
}
export interface VideoBrief {
  continuity?: 'continuous' | 'planned';
  prompt: string;
  targetSeconds: number;
  source?: VideoSource;
  sourceUsage?: 'reference' | 'include';
  sourceIn: number;
  sourceOut: number;
  script?: VideoScript;
  submittedPrompt?: string;
  submittedSource?: string;
  submittedRange?: string;
  submittedTarget?: number;
  submittedSourceUsage?: 'reference' | 'include';
}
export const EMPTY_VIDEO_BRIEF: VideoBrief = { prompt: '', continuity:'continuous', sourceUsage: 'reference', targetSeconds: 30, sourceIn: 0, sourceOut: 0 };
export const isSourceId = (value: unknown): value is string => typeof value === 'string' && /^s_[a-f0-9]{32}$/.test(value);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function readVideoScript(value: unknown): VideoScript | null {
  const input = object(value);
  if (text(input.title, 150) === null || text(input.sourceTranscript, 12000) === null || text(input.sourceDescription, 4000) === null || !Array.isArray(input.shots) || !input.shots.length || input.shots.length > 32) return null;
  const shots: ScriptShot[] = [];
  const ids = new Set<string>();
  for (const raw of input.shots) {
    const shot = object(raw);
    if (typeof shot.id !== 'string' || !/^[\w-]{1,80}$/.test(shot.id) || ids.has(shot.id) || text(shot.title, 150) === null || text(shot.visual, 4000) === null || text(shot.dialogue, 4000) === null || text(shot.audio, 1000) === null || !finite(shot.seconds) || shot.seconds < .1 || shot.seconds > 40 || !['original', 'presenter', 'screencast', 'generated'].includes(String(shot.source)) || !['cut', 'continue'].includes(String(shot.connection))) return null;
    if (shot.pauseSeconds !== undefined && (!finite(shot.pauseSeconds) || shot.pauseSeconds < 0 || shot.pauseSeconds > 30)) return null;
    ids.add(shot.id);
    shots.push(shot as unknown as ScriptShot);
  }
  if (shots.reduce((sum, shot) => sum + shot.seconds, 0) > 300) return null;
  return { title: input.title as string, sourceTranscript: input.sourceTranscript as string, sourceDescription: input.sourceDescription as string, shots };
}
export function readVideoBrief(value: unknown): VideoBrief | null {
  const input = object(value);
  if (text(input.prompt, 12000) === null || !finite(input.targetSeconds) || input.targetSeconds < 10 || input.targetSeconds > 180 || !finite(input.sourceIn) || !finite(input.sourceOut) || input.sourceIn < 0 || input.sourceOut < input.sourceIn) return null;
  const source = object(input.source);
  const validSource = isSourceId(source.id) && text(source.name, 200) !== null && finite(source.durationSeconds) && source.durationSeconds > 0 && source.durationSeconds <= 120 && finite(source.createdAt);
  if (input.source && (!validSource || input.sourceOut > Number(source.durationSeconds) + .025)) return null;
  const script = readVideoScript(input.script);
  return { ...(input.continuity==='continuous'||input.continuity==='planned'?{continuity:input.continuity}:{}),sourceUsage:input.sourceUsage==='include'?'include':'reference', prompt: input.prompt as string, targetSeconds: input.targetSeconds, sourceIn: input.sourceIn, sourceOut: input.sourceOut,
    ...(validSource ? {source: source as unknown as VideoSource} : {}), ...(script ? {script} : {}),
    ...(input.submittedSourceUsage==='reference'||input.submittedSourceUsage==='include'?{submittedSourceUsage:input.submittedSourceUsage}:{}),
    ...(typeof input.submittedPrompt === 'string' ? {submittedPrompt: input.submittedPrompt.slice(0,12000)} : {}),
    ...(typeof input.submittedSource === 'string' ? {submittedSource: input.submittedSource} : {}),
    ...(finite(input.submittedTarget) ? {submittedTarget:input.submittedTarget} : {}),
    ...(typeof input.submittedRange === 'string' ? {submittedRange: input.submittedRange} : {}),
  };
}
export function plannedShots(script: VideoScript, source?: VideoSource, usage: VideoBrief['sourceUsage'] = 'reference') {
  let start = 0;
  return script.shots.map((shot, index) => {
    const previous = script.shots[index - 1];
    const issue = shot.source === 'original' ? !source ? 'Attach the original footage.' : usage !== 'include' ? 'This section uses the recording, but the video is set to reference only. Redraft or choose Include original footage.' : null
      : shot.source === 'screencast' ? 'Record the real CLI demonstration.'
      : shot.source === 'presenter' ? 'New presenter dialogue needs a recording or a validated presenter workflow.'
      : shot.connection === 'continue' && (!previous || previous.source !== 'generated') ? 'This continuation needs a supported source clip; choose a cut to make an independent shot.'
      : null;
    const production = shot.source === 'original' ? 'Use uploaded footage' : shot.source === 'screencast' ? 'Needs screen recording' : shot.source === 'presenter' ? 'Presenter generation unavailable' : 'Generate video — planned';
    const item = {...shot, start, end: start + shot.seconds, issue, production};
    start = item.end;
    return item;
  });
}

/** Planning heuristic, not an audio measurement: 150 words/minute plus explicit viewing time. */
export function shotTiming(shot: ScriptShot) {
  const words = shot.dialogue.trim().split(/\s+/u).filter(Boolean).length;
  const speechSeconds = words / 2.5;
  const pauseSeconds = Math.max(shot.source === 'screencast' ? 3 : 0, shot.pauseSeconds ?? (shot.source === 'screencast' ? 3 : 1));
  const minimumSeconds = Math.ceil((speechSeconds + pauseSeconds) * 10) / 10;
  return {words,speechSeconds,pauseSeconds,minimumSeconds,
    rushed:shot.source !== 'original' && shot.seconds + .1 < minimumSeconds};
}
export function scriptTiming(script: VideoScript, target: number) {
  const total = script.shots.reduce((sum,shot)=>sum+shot.seconds,0);
  const difference = Math.round((total-target)*10)/10;
  const onTarget = Math.abs(difference) <= Math.max(2,target*.1);
  return {total,difference,onTarget,message:onTarget ? 'Within target range' : `${Math.abs(difference).toFixed(1)}s ${difference<0?'short of':'over'} the ${target}s target`};
}
