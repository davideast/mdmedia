"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";
import { Check, Copy, Download, ImageIcon, Layers, MessageSquare, SlidersHorizontal, X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { InspectorSection } from "@/components/workbench/inspector-section";
import { GenerationAction } from "@/components/generation/generation-action";
import { ImageAttachmentAction } from "@/components/media/image-attachment-action";
import { serializeSceneDirection, type SceneMode } from "@/lib/scene-direction";
import { useSceneComposer } from "./scene-composer-provider";
import { beatDuration } from '@/lib/scene-tracks';
import { MAX_EXPORT_CLIPS, MAX_EXPORT_SECONDS } from '@/lib/video-export';
import { BeatTrackInspector } from './beat-track-inspector';
import { BeatGenerationFeedback } from './beat-generation-feedback';

const MODES = [
  { value: "text", label: "From text", hint: "Describe the scene.", icon: MessageSquare },
  { value: "image", label: "From an image", hint: "Animate a first frame.", icon: ImageIcon },
  { value: "references", label: "From references", hint: "Carry a visual thread.", icon: Layers },
] satisfies Array<{ value: SceneMode; label: string; hint: string; icon: typeof MessageSquare }>;

export function SceneGenerationSettings({ actions,settingsOnly=false }: { actions?: ReactNode;settingsOnly?:boolean }) {
  const scene = useSceneComposer();
  const { draft, firstFrame, references } = scene;
  const [imageIssue, setImageIssue] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{ direction: string; message: string } | null>(null);
  const direction = serializeSceneDirection(draft);
  const hasDirection = draft.beats.some((beat) => beat.text.trim());
  const missingImage = draft.mode === "image" && !firstFrame;
  const missingReferences = draft.mode === "references" && !references.length;
  const included = scene.tracks.filter(track=>track.included);
  const readyCount = included.filter(track=>track.ready).length;
  const busy = included.some(track=>track.busy);
  const needsNewShot=included.some(track=>!track.ready&&!track.busy&&track.generationMode==='new');
  const canGenerate = scene.ready && hasDirection && (!needsNewShot||!missingImage && !missingReferences);
  const canRegenerate = scene.ready && hasDirection && !!included.length && (!included.some(track=>track.generationMode==='new')||!missingImage&&!missingReferences);
  const tooLong = included.some(track=>beatDuration(track.beat)>40);
  const total = included.at(-1)?.end ?? 0;
  const exportTooLarge = included.length>MAX_EXPORT_CLIPS || total>MAX_EXPORT_SECONDS;
  const missing = included.some(track=>!track.ready&&!track.busy);
  const status = scene.exportIssue ?? scene.batchIssue ?? (scene.exporting ? scene.exportJob?.message || 'Assembling final video' : !scene.ready ? 'Loading draft' : !hasDirection ? 'Write scene direction' : needsNewShot&&missingImage ? 'Add a first frame' : needsNewShot&&missingReferences ? 'Add a reference image' : tooLong ? 'Split beats longer than 40s' : exportTooLarge ? 'Export up to 32 beats and 300s' : scene.batchRunning ? scene.batchProgress??'Generating linked beats in order' : busy ? 'Generating individual beat clips' : scene.exportUrl && scene.exportCurrent ? 'Final video ready' : `${readyCount} of ${included.length} included beats ready`);
  const copyMessage = copyResult?.direction === direction ? copyResult.message : null;

  return (
    <WorkbenchPanel title={settingsOnly?"Scene settings":"Generation"} icon={<SlidersHorizontal size={13} strokeWidth={2} />} actions={actions}
      className="bg-surface-inset" bodyClassName="p-0">
      <div className="grid gap-7 p-4">
        {!settingsOnly&&scene.trackView ? <BeatTrackInspector canGenerate={scene.ready&&hasDirection&&!missingImage&&!missingReferences}/> : null}
        <InspectorSection title="Mode">
          <div className="grid gap-1">
            {MODES.map((mode) => {
              const Icon = mode.icon;
              const selected = draft.mode === mode.value;
              return (
                <button key={mode.value} type="button" aria-pressed={selected} onClick={() => scene.updateDraft({ mode: mode.value })}
                  className={cn("scene-mode-option", selected && "scene-mode-option--selected")}>
                  <Icon size={17} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
                  <span className="grid min-w-0 gap-0.5 text-left">
                    <span className="text-[0.84rem] font-medium">{mode.label}</span>
                    <span className="text-xs text-ink-muted">{mode.hint}</span>
                  </span>
                  {selected ? <Check size={14} className="ml-auto shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        </InspectorSection>

        <InspectorSection title="Frame">
          <div className="grid grid-cols-2 gap-2">
            {([{ value: "16:9", label: "Landscape" }, { value: "9:16", label: "Portrait" }] as const).map((frame) => (
              <button key={frame.value} type="button" aria-pressed={draft.frame === frame.value} onClick={() => scene.updateDraft({ frame: frame.value })}
                className={cn("scene-frame-option", draft.frame === frame.value && "scene-mode-option--selected")}>
                <span className={cn("scene-frame-outline", frame.value === "9:16" && "scene-frame-outline--portrait")} aria-hidden="true" />
                <span className="text-xs font-medium">{frame.label}</span>
                <span className="font-mono text-[0.7rem] text-ink-muted">{frame.value}</span>
              </button>
            ))}
          </div>
        </InspectorSection>

        <InspectorSection title="Images">
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.82rem]">First frame</span>
              <ImageAttachmentAction label={firstFrame ? "Replace" : "Add"} className="h-7 px-2 text-xs"
                onFiles={(files) => setImageIssue(scene.attachFirstFrame(files[0]!))} />
            </div>
            {firstFrame ? (
              <div className="flex min-w-0 items-center gap-2.5">
                <Image src={firstFrame.url} alt="Attached first frame" width={44} height={44} unoptimized className="h-11 w-11 shrink-0 rounded-md object-cover" />
                <span className="min-w-0 flex-1 break-all text-xs text-ink-muted">{firstFrame.name}</span>
                <Button variant="ghost" size="icon-xs" aria-label="Remove first frame" onClick={scene.removeFirstFrame}><X size={14} /></Button>
              </div>
            ) : <p className="t-meta">{draft.mode === "image" ? "Choose where the motion begins." : "Optional starting image."}</p>}
          </div>

          <div className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.82rem]">Reference images</span>
              <ImageAttachmentAction label="Add references" multiple className="h-7 px-2 text-xs"
                onFiles={(files) => setImageIssue(scene.attachReferences(files))} />
            </div>
            {references.length ? references.map((image) => (
              <div key={image.id} className="flex min-w-0 items-center gap-2.5">
                <Image src={image.url} alt={`Reference: ${image.name}`} width={44} height={44} unoptimized className="h-11 w-11 shrink-0 rounded-md object-cover" />
                <span className="min-w-0 flex-1 break-all text-xs text-ink-muted">{image.name}</span>
                <Button variant="ghost" size="icon-xs" aria-label={`Remove reference ${image.name}`} onClick={() => scene.removeReference(image.id)}><X size={14} /></Button>
              </div>
            )) : <p className="t-meta">Bring the subject or atmosphere into view.</p>}
          </div>
          {imageIssue ? <p role="alert" className="t-meta text-foreground">{imageIssue}</p> : null}
          <p className="t-meta">Images stay in this session. Attach them again after a reload.</p>
        </InspectorSection>
      </div>

      {!settingsOnly?<div className="scene-generation-footer">
        <GenerationAction status={copyMessage ?? status} label={scene.trackView ? scene.exporting ? 'Exporting final video' : 'Export final video' : scene.batchRunning||busy ? 'Generating beat clips' : missing ? readyCount?'Generate changed beats':'Generate beat clips' : 'Regenerate all beat clips'}
          onAction={() => { void (scene.trackView ? scene.exportScene() : missing ? scene.generateMissingBeats() : scene.regenerateAllBeats()); }}
          disabled={scene.trackView ? !scene.ready || !included.length || readyCount!==included.length || scene.exporting || exportTooLarge || scene.batchRunning : !(missing?canGenerate:canRegenerate) || tooLong || scene.batchRunning || busy || scene.exporting}
          helper={scene.trackView ? `${total.toFixed(1)}s sequence. Export joins the included clips in order, with trims and mute settings.` : missing ? 'Generate missing or changed beats from the current direction. Final export stays manual.' : 'Generate fresh footage for every included beat. Source trims reset; continuity choices are preserved. Final export stays manual.'}
          secondary={<div className="grid gap-2">
            {!scene.trackView?included.filter(track=>track.busy||track.issue||track.needsContinuation).map(track=><div key={track.beat.id} className="grid gap-2 border-t border-border pt-3"><BeatGenerationFeedback track={track} label={`Beat ${scene.tracks.indexOf(track)+1}`}/>{track.clip?.videoId?<Button variant="outline" size="sm" onClick={()=>scene.reloadJob(track.clip!.videoId!)}>Check beat {scene.tracks.indexOf(track)+1} status</Button>:null}</div>):null}
            {scene.trackView ? <Button variant="outline" size="sm" disabled={!canGenerate||!missing||tooLong||scene.batchRunning} onClick={()=>void scene.generateMissingBeats()}>Generate missing beats</Button> : <Button variant="outline" size="sm" onClick={()=>scene.setTrackView(true)}>Open beat tracks</Button>}
            {scene.trackView||missing?<Button variant="outline" size="sm" disabled={!canRegenerate||busy||tooLong||scene.batchRunning||scene.exporting} onClick={()=>void scene.regenerateAllBeats()}>Regenerate all beat clips</Button>:null}
            {!canRegenerate&&(missingImage||missingReferences)?<p className="t-meta">Reattach {missingImage?'the first frame':'reference images'} to regenerate new shots.</p>:null}
            {scene.exportIssue&&scene.exportRequestId ? <Button variant="outline" size="sm" onClick={()=>scene.reloadJob(scene.exportRequestId!)}>Check export status</Button> : null}
            {scene.exportUrl ? <Button variant="outline" size="sm" onClick={()=>scene.downloadJob(scene.exportJob!.id)}><Download size={14}/>Download final MP4</Button> : null}
            {scene.videoUrl ? <Button variant="ghost" size="sm" onClick={scene.downloadClip}><Download size={14}/>Download earlier scene video</Button> : null}
            <Button variant="ghost" size="sm" className="w-full text-ink-muted" disabled={!direction || !scene.ready}
            onClick={async () => {
              try { await navigator.clipboard.writeText(direction); setCopyResult({ direction, message: "Direction copied" }); }
              catch { setCopyResult({ direction, message: "Copy is unavailable. Select your direction and copy it manually." }); }
            }}><Copy size={14} />Copy direction</Button></div>} />
        <p className="px-4 pb-4 text-xs text-ink-muted">
          {scene.storageAvailable ? "Your draft stays on this browser." : "Browser storage is unavailable. Keep this tab open or copy your direction."}
        </p>
      </div>:null}
    </WorkbenchPanel>
  );
}
