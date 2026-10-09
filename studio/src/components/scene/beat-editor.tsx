"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Camera, ChevronDown, Expand, Minimize2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  CAMERA_MOVES, CONTINUOUS_SHOT, formatBeatTime, hasOverlappingCues,
  insertCameraPhrase, setContinuousShot, timingError, type SceneBeat,
} from "@/lib/scene-direction";

function TimingCue({ beat, number, onChange }: {
  beat: SceneBeat;
  number: number;
  onChange: (start: number | null, end: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const save = () => {
    const problem = timingError(start, end);
    if (problem) { setError(problem); return; }
    onChange(start.trim() ? Number(start) : null, end.trim() ? Number(end) : null);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(next) => {
      if (next) { setStart(beat.start === null ? "" : String(beat.start)); setEnd(beat.end === null ? "" : String(beat.end)); setError(null); }
      setOpen(next);
    }}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="xs" className="scene-beat__time" aria-label={`Edit time cue for beat ${number}: ${formatBeatTime(beat)}`}>
          {formatBeatTime(beat)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid gap-3 rounded-lg bg-popover p-4 backdrop-blur-none"
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}>
        <p className="text-sm font-medium">Beat {number} timing</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-start`}>Start (s)</Label>
            <Input id={`${id}-start`} type="number" min="0" step="any" value={start} onChange={(event) => { setStart(event.target.value); setError(null); }}
              aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-end`}>End (s)</Label>
            <Input id={`${id}-end`} type="number" min="0" step="any" value={end} onChange={(event) => { setEnd(event.target.value); setError(null); }}
              aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
          </div>
        </div>
        {error ? <p id={`${id}-error`} role="alert" className="t-meta text-foreground">{error}</p> : <p className="t-meta">Clear both fields to remove the cue.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={save}>Save cue</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CameraSketch({ move }: { move: typeof CAMERA_MOVES[number]["id"] }) {
  return (
    <svg viewBox="0 0 48 32" width="48" height="32" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true" className="shrink-0 text-ink-muted">
      <rect x="4" y="4" width="40" height="24" rx="2" opacity=".5" />
      {move === "locked" ? <path d="M18 12h12v8H18zM24 9v3M24 20v3" /> :
        move === "push" ? <path d="M13 10v12h22V10H13ZM19 14h10v4H19M9 16h5m-3-3 3 3-3 3M39 16h-5m3-3-3 3 3 3" /> :
        move === "pull" ? <path d="M19 12h10v8H19zM14 16H8m3-3-3 3 3 3M34 16h6m-3-3 3 3-3 3" /> :
        move === "pan" ? <path d="M10 16h28m-5-5 5 5-5 5" /> :
        <path d="M12 21l10-10 7 7 9-9m-7 0h7v7" />}
    </svg>
  );
}

function BeatText({ beat, number, register, onChange, onSelection }: {
  beat: SceneBeat;
  number: number;
  register: (id: string, node: HTMLTextAreaElement | null) => void;
  onChange: (text: string) => void;
  onSelection: (node: HTMLTextAreaElement) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const resize = () => { node.style.height = "0px"; node.style.height = `${Math.max(56, node.scrollHeight)}px`; };
    resize();
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; resize(); }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [beat.text]);
  return (
    <textarea ref={(node) => { input.current = node; register(beat.id, node); }} className="scene-beat__text"
      aria-label={`Beat ${number} direction`} value={beat.text} placeholder="Describe what happens"
      rows={2} onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => onSelection(event.currentTarget)} onSelect={(event) => onSelection(event.currentTarget)}
      onBlur={(event) => onSelection(event.currentTarget)} />
  );
}

export function BeatEditor({ beats, note, onChange, focusWriting, onFocusWriting }: {
  beats: SceneBeat[];
  note: string;
  onChange: (patch: { beats?: SceneBeat[]; note?: string }) => void;
  focusWriting: boolean;
  onFocusWriting: (enabled: boolean) => void;
}) {
  const nodes = useRef(new Map<string, HTMLTextAreaElement>());
  const selection = useRef<{ id: string; start: number; end: number } | null>(null);
  const cameraInserted = useRef(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const continuousId = useId();
  const noteId = useId();
  const editorId = useId();
  const continuous = note.includes(CONTINUOUS_SHOT);
  const updateBeat = (id: string, patch: Partial<SceneBeat>) => onChange({ beats: beats.map((beat) => beat.id === id ? { ...beat, ...patch } : beat) });
  const focusBeat = (id: string, caret?: number) => requestAnimationFrame(() => {
    const node = nodes.current.get(id);
    node?.focus();
    if (node && caret !== undefined) node.setSelectionRange(caret, caret);
  });
  const addBeat = () => {
    const beat: SceneBeat = { id: crypto.randomUUID(), text: "", start: null, end: null };
    onChange({ beats: [...beats, beat] });
    focusBeat(beat.id);
  };
  const insertPhrase = (phrase: string) => {
    const target = beats.find((beat) => beat.id === selection.current?.id) ?? beats[0];
    if (!target) return;
    const saved = selection.current?.id === target.id ? selection.current : null;
    const result = insertCameraPhrase(target.text, saved?.start ?? target.text.length, saved?.end ?? target.text.length, phrase);
    updateBeat(target.id, { text: result.text });
    selection.current = { id: target.id, start: result.caret, end: result.caret };
    cameraInserted.current = true;
    setCameraOpen(false);
    focusBeat(target.id, result.caret);
  };
  const moveBeat = (index: number, delta: number) => {
    const next = [...beats];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    onChange({ beats: next });
  };
  const deleteBeat = (index: number) => {
    if (beats.length === 1) {
      updateBeat(beats[0]!.id, { text: "", start: null, end: null });
      focusBeat(beats[0]!.id);
    } else {
      const next = beats.filter((_, position) => position !== index);
      onChange({ beats: next });
      focusBeat(next[Math.min(index, next.length - 1)]!.id);
    }
  };

  return (
    <section className="scene-direction" aria-labelledby={`${editorId}-title`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${editorId}-title`} className="text-sm font-semibold">Scene direction</h2>
        <Button variant="ghost" size="sm" className="text-ink-muted" aria-expanded={focusWriting} aria-controls={editorId}
          onClick={() => onFocusWriting(!focusWriting)}>
          {focusWriting ? <Minimize2 size={14} /> : <Expand size={14} />}
          {focusWriting ? "Back to preview" : "Focus writing"}
        </Button>
      </div>
      <div className="scene-direction__toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={addBeat}><Plus size={15} />Add beat</Button>
          <Popover open={cameraOpen} onOpenChange={(open) => {
            if (open) cameraInserted.current = false;
            setCameraOpen(open);
          }}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm"><Camera size={15} />Camera<ChevronDown size={13} /></Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] rounded-lg bg-popover p-2 backdrop-blur-none"
              onCloseAutoFocus={(event) => { if (cameraInserted.current) event.preventDefault(); }}>
              <p className="px-2 pb-2 pt-1 text-xs text-ink-muted">Add camera direction to your active beat.</p>
              <div className="grid gap-0.5">
                {CAMERA_MOVES.map((move) => (
                  <button key={move.id} type="button" className="scene-camera-option" onClick={() => insertPhrase(move.phrase)}>
                    <CameraSketch move={move.id} />
                    <span className="grid min-w-0 gap-0.5 text-left">
                      <span className="text-[0.82rem] font-medium">{move.label}</span>
                      <span className="text-xs leading-relaxed text-ink-muted">{move.phrase}</span>
                    </span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <label htmlFor={continuousId} className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
          <input id={continuousId} type="checkbox" className="scene-checkbox" checked={continuous}
            onChange={(event) => onChange({ note: setContinuousShot(note, event.target.checked) })} />
          One continuous shot
        </label>
      </div>
      <div id={editorId} className="scene-direction__document">
        <div className="grid gap-5">
          {beats.map((beat, index) => (
            <div className="scene-beat" key={beat.id}>
              <TimingCue beat={beat} number={index + 1} onChange={(start, end) => updateBeat(beat.id, { start, end })} />
              <BeatText beat={beat} number={index + 1} register={(id, node) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); }}
                onChange={(text) => updateBeat(beat.id, { text })}
                onSelection={(node) => { selection.current = { id: beat.id, start: node.selectionStart, end: node.selectionEnd }; }} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="text-ink-muted" aria-label={`Actions for beat ${index + 1}`}><ChevronDown size={14} /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={index === 0} onSelect={() => moveBeat(index, -1)}><ArrowUp size={14} />Move up</DropdownMenuItem>
                  <DropdownMenuItem disabled={index === beats.length - 1} onSelect={() => moveBeat(index, 1)}><ArrowDown size={14} />Move down</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => deleteBeat(index)}><Trash2 size={14} />Delete beat</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
        <div className="scene-direction__note">
          <Label htmlFor={noteId} className="text-xs font-normal text-ink-muted">Across the scene</Label>
          <Textarea id={noteId} value={note} onChange={(event) => onChange({ note: event.target.value })}
            placeholder="Lighting, appearance, or continuity to keep throughout" rows={2} className="min-h-16 resize-y bg-transparent text-sm leading-relaxed" />
        </div>
        <p className="t-meta">Time cues guide the scene.</p>
        {hasOverlappingCues(beats) ? <p role="status" className="t-meta text-foreground">Some time cues overlap. Adjust them if the actions should happen in order.</p> : null}
      </div>
    </section>
  );
}
