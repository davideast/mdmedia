'use client';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {plannedShots,scriptTiming,shotTiming,type VideoBrief,type ScriptShot} from '@/lib/video-script';
import {scriptContinuity} from '@/lib/script-continuity';
const SOURCE_NAMES={original:'Original footage',presenter:'Presenter',screencast:'Real screencast',generated:'Generated cutaway'};

export function VideoScriptReader({brief,disabled,onChange}:{brief:VideoBrief;disabled:boolean;onChange:(changes:Partial<VideoBrief>)=>void}){
  const script=brief.script;
  if(!script)return null;
  const continuous=scriptContinuity(brief,script)==='continuous';
  const shots=plannedShots(continuous?{...script,shots:script.shots.map((shot,index)=>({...shot,connection:index?'continue':'cut'}))}:script,brief.source,brief.sourceUsage);
  const timing=scriptTiming(script,brief.targetSeconds);
  const update=(id:string,changes:Partial<ScriptShot>)=>onChange({script:{...script,shots:script.shots.map(shot=>shot.id===id?{...shot,...changes}:shot)}});
  return <section className="video-script" aria-label="Script and production plan">
    <div className="video-script-title"><label>Script title<Input value={script.title} maxLength={150} disabled={disabled} onChange={event=>onChange({script:{...script,title:event.target.value}})}/></label><div className="script-duration-summary"><span>{timing.total.toFixed(1)}s drafted / {brief.targetSeconds}s target</span><span role="status">{timing.message}</span></div></div>
    <p className="text-sm text-ink-muted">Read the story from beginning to end. These are production instructions; no new video, voiceover, music or sound effects have been made.</p>
    <div className="script-production-summary" aria-label="Production summary">{Object.entries(SOURCE_NAMES).map(([source,label])=>{const count=shots.filter(shot=>shot.source===source).length;return count?<span key={source}>{count} {label.toLowerCase()}{count===1?' section':' sections'}</span>:null;})}</div>
    <div className="script-story">{shots.map((shot,index)=>{
      const pace=shotTiming(shot);
      return <fieldset key={shot.id} disabled={disabled} className="script-story-section" aria-label={`Section ${index+1}: ${shot.title}`}>
        <div className="script-section-heading"><span className="script-section-time">{shot.start.toFixed(1)}–{shot.end.toFixed(1)}s</span><Input aria-label={`Section ${index+1} title`} value={shot.title} maxLength={150} onChange={event=>update(shot.id,{title:event.target.value})}/><span className="script-production-status">{shot.production}</span></div>
        {shot.issue?<p className="script-section-issue">{shot.issue}</p>:null}
        <div className="script-story-columns"><label>{shot.source==='original'?'Recorded words (unchanged)':'Spoken words'}<textarea rows={Math.min(8,Math.max(2,Math.ceil(shot.dialogue.length/85)))} readOnly={shot.source==='original'} value={shot.dialogue} maxLength={4000} placeholder="No dialogue" onChange={event=>update(shot.id,{dialogue:event.target.value})}/>{shot.source!=='original'&&shot.dialogue.trim()?<span className="text-xs text-ink-muted">{shot.source==='presenter'?'On-camera delivery needs a supported presenter workflow.':'Voiceover needs to be recorded or generated separately.'}</span>:null}</label><label>What viewers see<textarea rows={Math.min(8,Math.max(2,Math.ceil(shot.visual.length/85)))} value={shot.visual} maxLength={4000} onChange={event=>update(shot.id,{visual:event.target.value})}/></label></div>
        {shot.source==='original'?<p className="script-pacing">Duration and speech come from the recording. Change the selected source range and redraft to use a different opening.</p>:<div className="script-pacing" role="status"><span>{pace.words} words ≈ {pace.speechSeconds.toFixed(1)}s speaking + {pace.pauseSeconds}s for action and pauses.</span><strong>{pace.rushed?`Too rushed: allow about ${pace.minimumSeconds}s or shorten the words.`:`${shot.seconds}s allocated.`}</strong>{pace.rushed&&pace.minimumSeconds<=40&&timing.total-shot.seconds+pace.minimumSeconds<=300?<Button variant="outline" size="xs" onClick={()=>update(shot.id,{seconds:pace.minimumSeconds})}>Allow {pace.minimumSeconds}s</Button>:null}</div>}
        <details className="script-section-settings"><summary>Timing, footage and sound direction</summary><div className="script-settings-grid">
          <label>Footage<select value={shot.source} onChange={event=>update(shot.id,{source:event.target.value as ScriptShot['source']})}>{Object.entries(SOURCE_NAMES).map(([value,label])=><option key={value} value={value} disabled={value==='original'&&(!brief.source||brief.sourceUsage!=='include')}>{label}</option>)}</select></label>
          <label>Connection<select disabled={continuous} value={shot.connection} onChange={event=>update(shot.id,{connection:event.target.value as ScriptShot['connection']})}><option value="continue" disabled={!index}>Continue previous shot</option><option value="cut">Start a new shot</option></select>{continuous?<span className="text-xs text-ink-muted">Set by One continuous shot.</span>:null}</label>
          <label>Section length (s)<Input type="number" min="0.1" max="40" step="0.1" value={shot.seconds} disabled={shot.source==='original'} onChange={event=>{const value=Number(event.target.value);if(value>=.1&&value<=40&&timing.total-shot.seconds+value<=300)update(shot.id,{seconds:value});}}/></label>
          <label>Extra action and pauses (s)<Input type="number" min={shot.source==='screencast'?3:0} max="30" step="0.5" value={pace.pauseSeconds} disabled={shot.source==='original'} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>=0&&value<=30)update(shot.id,{pauseSeconds:value});}}/></label>
          <label className="script-sound-direction">Music and sound cues — planned only<textarea rows={2} value={shot.audio} maxLength={1000} placeholder="No additional sound direction" onChange={event=>update(shot.id,{audio:event.target.value})}/></label>
        </div></details>
      </fieldset>;
    })}</div>
    <p className="text-xs text-ink-muted">Timing uses a planning estimate of 150 words per minute plus extra action and pauses. A timed read and the finished recordings determine the final duration.</p>
    {brief.source?<details className="video-source-analysis"><summary>Reference observations and transcript</summary><p>{script.sourceDescription}</p><p><strong>Recorded words (for reference): </strong>{script.sourceTranscript||'No intelligible speech detected.'}</p>{brief.sourceUsage!=='include'?<p>These words are not part of the new script. The upload supplies appearance and setting only.</p>:null}</details>:null}
  </section>;
}
