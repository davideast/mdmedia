"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useNarration } from "@/components/shell/narration-provider";
import {
  DEFAULT_HEADING_INSTRUCTIONS,
  DEFAULT_TTS_MODEL,
  TTS_MODELS,
  VOICES,
  type TTSModelName,
  type Visibility,
  type VoiceName,
} from "@/lib/types";
import { SlidersHorizontal } from "lucide-react";

const VISIBILITY: ReadonlyArray<{ value: Visibility; label: string; hint: string }> = [
  { value: "private", label: "Only me", hint: "Nobody else can open it." },
  { value: "shared", label: "People I choose", hint: "You pick who, after it is made." },
  { value: "public", label: "Anyone with the link", hint: "No sign-in required to listen." },
];

import type { ReactNode } from "react";

/** Voice and delivery controls for the composer. */
export function ComposerSettings({ actions }: { actions?: ReactNode }) {
  const { draft, setDraft } = useNarration();

  return (
    <WorkbenchPanel
      title="Voice"
      icon={<SlidersHorizontal size={13} strokeWidth={2} />}
      actions={actions}
      bodyClassName="gap-6 p-4"
    >
      <div className="grid gap-2">
        <Label htmlFor="voice" className="t-label">
          Reader
        </Label>
        <Select
          value={draft.voice}
          onValueChange={(value) => setDraft({ voice: value as VoiceName })}
        >
          <SelectTrigger id="voice" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {!VOICES.includes(draft.voice as any) && draft.voice ? (
              <SelectItem key={draft.voice} value={draft.voice}>
                {draft.voice} (Custom)
              </SelectItem>
            ) : null}
            {VOICES.map((voice) => (
              <SelectItem key={voice} value={voice}>
                {voice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="model" className="t-label">
          Model
        </Label>
        <Select
          value={draft.model ?? DEFAULT_TTS_MODEL}
          onValueChange={(value) => setDraft({ model: value as TTSModelName })}
        >
          <SelectTrigger id="model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TTS_MODELS.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="speed" className="t-label">
          Pace
        </Label>
        <Select
          value={String(draft.speed ?? 1.0)}
          onValueChange={(value) => setDraft({ speed: parseFloat(value) })}
        >
          <SelectTrigger id="speed" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0.75">0.75x (Relaxed)</SelectItem>
            <SelectItem value="1">1.0x (Normal)</SelectItem>
            <SelectItem value="1.25">1.25x (Brisk)</SelectItem>
            <SelectItem value="1.5">1.5x (Fast)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="style" className="t-label">
          Delivery
        </Label>
        <Textarea
          id="style"
          value={draft.promptStyle}
          onChange={(event) => setDraft({ promptStyle: event.target.value })}
          rows={3}
          className="resize-none"
          placeholder="Warm, unhurried narration."
        />
      </div>

      <div className="grid grid-cols-[1fr_auto] items-center gap-3">
        <div className="grid gap-0.5">
          <Label htmlFor="structure" className="t-card-title cursor-pointer font-normal">
            Clean document structure
          </Label>
          <span className="text-[0.78rem] text-ink-muted">
            Format headings, fences, tables, and Mermaid charts.
          </span>
        </div>
        <Switch
          id="structure"
          checked={draft.structureMarkdown ?? false}
          onCheckedChange={(checked) => setDraft({ structureMarkdown: checked })}
        />
      </div>

      <div className="grid grid-cols-[1fr_auto] items-center gap-3">
        <div className="grid gap-0.5">
          <Label htmlFor="verbalize-diagrams" className="t-card-title cursor-pointer font-normal">
            Verbalize diagrams
          </Label>
          <span className="text-[0.78rem] text-ink-muted">
            Translate Mermaid and ASCII diagrams into spoken descriptions.
          </span>
        </div>
        <Switch
          id="verbalize-diagrams"
          checked={draft.verbalizeDiagrams ?? false}
          onCheckedChange={(checked) => setDraft({ verbalizeDiagrams: checked })}
        />
      </div>

      <div className="grid grid-cols-[1fr_auto] items-center gap-3">
        <Label htmlFor="rewrite" className="t-card-title cursor-pointer font-normal">
          Rewrite for the ear
        </Label>
        <Switch
          id="rewrite"
          checked={draft.rewriteForNarration}
          onCheckedChange={(checked) => setDraft({ rewriteForNarration: checked })}
        />
      </div>

      {draft.rewriteForNarration ? (
        <div className="grid gap-2">
          <Label htmlFor="rewrite-instructions" className="t-label">
            Custom instructions
          </Label>
          <Textarea
            id="rewrite-instructions"
            value={draft.rewriteInstructions ?? DEFAULT_HEADING_INSTRUCTIONS}
            onChange={(event) => setDraft({ rewriteInstructions: event.target.value })}
            rows={5}
            className="resize-none font-mono text-[0.75rem] leading-relaxed"
            placeholder="Custom instructions for adapting markdown..."
          />
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="visibility" className="t-label">
          Who can listen
        </Label>
        <Select
          value={draft.visibility}
          onValueChange={(value) => setDraft({ visibility: value as Visibility })}
        >
          <SelectTrigger id="visibility" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VISIBILITY.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="t-meta">
          {VISIBILITY.find((option) => option.value === draft.visibility)?.hint}
        </p>
      </div>
    </WorkbenchPanel>
  );
}
