'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Download, Pause, Play, Repeat2, Volume2, VolumeX, Activity, AudioLines } from 'lucide-react';
import { MediaIconAction } from './media-composer';
import { downloadPrivateMedia, usePrivateMedia } from './private-media';
import type { MusicGenerationResource } from '@/lib/media-types';

const clock = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
/** Decorative oscilloscope and spectrum: always driven by the audio, never an idle animation. */
function MusicVisualization({ analyser, playing, enabled }: { analyser: React.RefObject<AnalyserNode | null>; playing: boolean; enabled: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, context = element?.getContext('2d');
    if (!element || !context) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const time = new Uint8Array(512), frequency = new Uint8Array(256);
    const draw = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) { element.width = Math.round(width * ratio); element.height = Math.round(height * ratio); }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      const active = enabled && playing && !reduced.matches && !document.hidden && analyser.current;
      time.fill(128); frequency.fill(0);
      if (active) { active.getByteTimeDomainData(time); active.getByteFrequencyData(frequency); }
      const color = getComputedStyle(element).color;
      context.strokeStyle = color; context.fillStyle = color;
      // Low frequencies form a soft bed; the waveform traces actual sample displacement.
      context.globalAlpha = active ? 0.16 : 0.06;
      for (let i = 0; i < 48; i++) {
        const amplitude = frequency[Math.floor(i * frequency.length / 96)] / 255;
        const bar = Math.max(2, amplitude * height * 0.42);
        context.fillRect(i * width / 48 + 1, height / 2 - bar / 2, Math.max(1, width / 48 - 3), bar);
      }
      for (let layer = 0; layer < 3; layer++) {
        context.beginPath(); context.lineWidth = layer === 0 ? 1.8 : 1; context.globalAlpha = layer === 0 ? 0.85 : 0.16;
        for (let i = 0; i < time.length; i++) {
          const x = i / (time.length - 1) * width;
          const displacement = (time[i] - 128) / 128 * height * (0.36 - layer * 0.07);
          const y = height / 2 + displacement + (layer - 1) * 5;
          if (!i) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.stroke();
      }
      if (active) frame = requestAnimationFrame(draw);
    };
    const restart = () => { cancelAnimationFrame(frame); draw(); };
    const resize = new ResizeObserver(restart); resize.observe(element);
    reduced.addEventListener('change', restart); document.addEventListener('visibilitychange', restart); draw();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); reduced.removeEventListener('change', restart); document.removeEventListener('visibilitychange', restart); };
  }, [analyser, playing, enabled]);
  return <canvas ref={canvas} aria-hidden="true" className="h-40 w-full text-primary sm:h-56" />;
}

export function MusicPlayer({ result, title, onStart, otherAudioPlaying = false }: {
  result: MusicGenerationResource; title: string; onStart?: () => void; otherAudioPlaying?: boolean;
}) {
  const asset = result.assets[0];
  const media = usePrivateMedia(asset ? `/api/v1/assets/${asset.id}/content` : null);
  const audio = useRef<HTMLAudioElement>(null), analyser = useRef<AnalyserNode | null>(null);
  const graph = useRef<{ context: AudioContext; source: MediaElementAudioSourceNode } | null>(null);
  const [playing, setPlaying] = useState(false), [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(result.durationSeconds ?? 0), [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false), [visuals, setVisuals] = useState(true), [error, setError] = useState('');
  const clipId = useId();
  useEffect(() => { const element = audio.current; return () => { element?.pause(); graph.current?.source.disconnect(); void graph.current?.context.close(); }; }, []);
  useEffect(() => { if (otherAudioPlaying) audio.current?.pause(); }, [otherAudioPlaying]);
  async function toggle() {
    const element = audio.current; if (!element) return;
    if (!element.paused) { element.pause(); return; }
    try {
      // Create and resume within the user's play gesture (including mobile Safari).
      if (!graph.current && typeof AudioContext !== 'undefined') {
        const context = new AudioContext(), source = context.createMediaElementSource(element), node = context.createAnalyser();
        node.fftSize = 512; node.smoothingTimeConstant = 0.8; source.connect(node); node.connect(context.destination);
        graph.current = { context, source }; analyser.current = node;
      }
      await graph.current?.context.resume(); onStart?.();
      await element.play(); setError('');
    } catch { setError('Playback could not start. Try Play again.'); }
  }
  const percent = duration > 0 ? Math.min(100, position / duration * 100) : 0;
  return <section aria-label="Music player" className="grid shrink-0 gap-4 p-4 pb-0 sm:p-6 sm:pb-0">
    <div className="overflow-hidden rounded-lg border border-border bg-card/50">
      <MusicVisualization analyser={analyser} playing={playing} enabled={visuals} />
      <div className="grid gap-3 px-4 pb-4">
        <div className="relative rounded-md focus-within:ring-2 focus-within:ring-ring">
          <svg aria-hidden="true" viewBox="0 0 768 52" preserveAspectRatio="none" className="h-12 w-full text-primary">
            <defs><clipPath id={clipId}><rect width={768 * percent / 100} height="52" /></clipPath></defs>
            {[false, true].map(active => <g key={String(active)} fill="currentColor" opacity={active ? 0.9 : 0.2} clipPath={active ? `url(#${clipId})` : undefined}>
              {result.waveform.map((peak, i) => <rect key={i} x={i * 3} y={26 - Math.max(2, peak * 23)} width="1.5" height={Math.max(4, peak * 46)} rx="0.75" />)}
            </g>)}
          </svg>
          <input type="range" min="0" max={Math.max(1, duration)} step="0.1" value={Math.min(position, duration)} aria-label="Seek music" aria-valuetext={`${clock(position)} of ${clock(duration)}`} disabled={!media.url}
            onChange={event => { if (audio.current) { audio.current.currentTime = Number(event.target.value); setPosition(Number(event.target.value)); } }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait" />
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" aria-label={playing ? 'Pause music' : 'Play music'} disabled={!media.url} onClick={() => void toggle()} className="mr-2 grid size-12 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}</button>
          <span className="mr-auto whitespace-nowrap font-mono text-xs tabular-nums text-ink-muted">{clock(position)} / {clock(duration)}</span>
          <MediaIconAction compact label="Loop music" aria-pressed={loop} onClick={() => setLoop(!loop)}><Repeat2 size={16} /></MediaIconAction>
          <MediaIconAction compact label={muted ? 'Unmute music' : 'Mute music'} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</MediaIconAction>
          <MediaIconAction compact label="Audio visualization" aria-pressed={visuals} onClick={() => setVisuals(!visuals)}>{visuals ? <Activity size={16} /> : <AudioLines size={16} />}</MediaIconAction>
          <MediaIconAction compact label="Download music" disabled={!asset} onClick={() => void downloadPrivateMedia(`/api/v1/assets/${asset.id}/content?download=1`, `${title}.${asset.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`).catch(() => setError('Download failed. Try again.'))}><Download size={16} /></MediaIconAction>
        </div>
      </div>
    </div>
    <audio ref={audio} src={media.url || undefined} preload="metadata" loop={loop} muted={muted} aria-label={title}
      onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }} onError={() => setError('This audio could not be played. Try downloading it.')} />
    {(error || media.error) && <p role="alert" className="text-sm text-destructive">{error || media.error}</p>}
  </section>;
}
