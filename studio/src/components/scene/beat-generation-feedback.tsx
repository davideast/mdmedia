"use client";
import { useEffect,useState } from 'react';
import { beatGenerationFeedback,type BeatGenerationState } from '@/lib/scene-generation-feedback';

export function BeatGenerationFeedback({track,label}:{track:BeatGenerationState;label?:string}) {
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{if(!track.busy)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[track.busy]);
 const feedback=beatGenerationFeedback(track,now);
 return <div className="grid gap-1.5" aria-label={label??'Beat generation status'}>
  <p role="status" aria-live="polite" className="text-xs text-foreground">{label?`${label} / `:''}{feedback.status}: {feedback.detail}</p>
  {feedback.elapsed?<p className="font-mono text-xs text-ink-muted" aria-live="off">{feedback.elapsed}</p>:null}
  {feedback.slow?<p className="t-meta">{feedback.slow}</p>:null}
 </div>;
}
