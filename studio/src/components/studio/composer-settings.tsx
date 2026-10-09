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
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useNarration } from "@/components/shell/narration-provider";
import { PresetField } from "@/components/studio/preset-field";
import { VoicePicker } from "@/components/studio/voice-picker";
import { useAuth } from "@/lib/auth-context";
import { addPreset } from "@/lib/presets";
import {
  DEFAULT_SETTINGS,
  DELIVERY_PRESETS,
  INSTRUCTION_PRESETS,
  type Visibility,
} from "@/lib/types";
import Link from "next/link";
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
  const { profile, updateSettings } = useAuth();
  const settings = profile?.settings ?? DEFAULT_SETTINGS;
  const deliveryPresets = [...DELIVERY_PRESETS, ...settings.deliveryPresets];
  const instructionPresets = [...INSTRUCTION_PRESETS, ...settings.instructionPresets];

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
        <VoicePicker id="voice" value={draft.voice} onChange={(voice) => setDraft({ voice })} />
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

      {draft.voice.provider === "gemini" ? (
        <PresetField
          id="style"
          label="Delivery"
          presets={deliveryPresets}
          text={draft.promptStyle}
          choice={draft.deliveryPreset}
          onChange={({ text, choice }) => setDraft({ promptStyle: text, deliveryPreset: choice })}
          onSave={(preset) => void updateSettings({ deliveryPresets: addPreset(settings.deliveryPresets, preset) })}
          placeholder="Warm, unhurried narration."
        />
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
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
        <PresetField
          id="rewrite-instructions"
          label="Custom instructions"
          presets={instructionPresets}
          text={draft.rewriteInstructions ?? settings.defaultRewriteInstructions}
          choice={draft.instructionPreset}
          onChange={({ text, choice }) => setDraft({ rewriteInstructions: text, instructionPreset: choice })}
          onSave={(preset) => void updateSettings({ instructionPresets: addPreset(settings.instructionPresets, preset) })}
          rows={5}
          textareaClassName="font-mono text-[0.75rem] leading-relaxed"
          placeholder="Custom instructions for adapting markdown..."
        />
      ) : null}

      <p className="t-meta">
        Document structure and diagram narration are set in{" "}
        <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">Settings</Link>.
      </p>

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
