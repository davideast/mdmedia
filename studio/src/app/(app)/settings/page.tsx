"use client";

import { LogOut, Settings as SettingsIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useNarration } from "@/components/shell/narration-provider";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { ConnectedApps } from "@/components/studio/connected-apps";
import { PresetList } from "@/components/studio/preset-list";
import { VoicePicker } from "@/components/studio/voice-picker";
import { useAuth } from "@/lib/auth-context";
import { ONE_OFF, selectedPresetId } from "@/lib/presets";
import {
  DEFAULT_SETTINGS,
  DELIVERY_PRESETS,
  INSTRUCTION_PRESETS,
  HIGHLIGHT_COLORS,
  settingsDefaultVoice,
  TTS_MODELS,
  type HighlightColorId,
  type TextPreset,
  type TTSModelName,
  type UserSettings,
  type Visibility,
} from "@/lib/types";

const VISIBILITY: ReadonlyArray<{ value: Visibility; label: string }> = [
  { value: "private", label: "Only me" },
  { value: "shared", label: "People I choose" },
  { value: "public", label: "Anyone with the link" },
];

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 items-center gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] md:gap-6">
      <div className="grid min-w-0 gap-1">
        <Label htmlFor={htmlFor} className="t-card-title font-normal">
          {label}
        </Label>
        {hint === undefined ? null : <p className="t-meta">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** Chooses which preset new narrations start with. */
function DefaultPresetSelect({
  id,
  presets,
  text,
  onChange,
}: {
  id: string;
  presets: readonly TextPreset[];
  text: string;
  onChange: (text: string) => void;
}) {
  const selected = selectedPresetId(presets, text, undefined);
  return (
    <Select
      value={selected}
      onValueChange={(value) => {
        const preset = presets.find((item) => item.id === value);
        if (preset) onChange(preset.text);
      }}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {presets.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>
        ))}
        {selected === ONE_OFF ? <SelectItem value={ONE_OFF} disabled>Current text (not a preset)</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}

export default function SettingsPage() {
  const { profile, defaultReader, updateSettings, signOutUser } = useAuth();
  const { highlightColor, setHighlightColor } = useNarration();
  const { theme, setTheme } = useTheme();

  const settings: UserSettings = profile?.settings ?? DEFAULT_SETTINGS;
  const deliveryPresets = [...DELIVERY_PRESETS, ...settings.deliveryPresets];
  const instructionPresets = [...INSTRUCTION_PRESETS, ...settings.instructionPresets];

  const save = (patch: Partial<UserSettings>) => {
    try {
      void updateSettings(patch, {
        onError: () => toast.error("That setting did not save. Try again."),
      });
    } catch {
      toast.error("That setting did not save. Try again.");
    }
  };

  return (
    <WorkbenchPanel
      workspacePage
      title="Settings"
      icon={<SettingsIcon size={13} strokeWidth={2} />}
      viewGrid
      gridVariant="wide"
    >
      <p className="t-lead">These apply to every new narration you start.</p>

        <div className="grid min-w-0 gap-6">
          <Row label="Appearance" htmlFor="appearance-theme">
            <Select value={theme ?? "system"} onValueChange={setTheme}>
              <SelectTrigger id="appearance-theme" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Separator />

          <Row
            label="Highlight color"
            hint="Accessible inline highlight background and text color while listening."
            htmlFor="highlight-color"
          >
            <div id="highlight-color" className="grid min-w-0 grid-cols-3 gap-2">
              {HIGHLIGHT_COLORS.map((preset) => {
                const selected = highlightColor === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setHighlightColor(preset.id as HighlightColorId)}
                    className={`flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[0.78rem] transition-all ${
                      selected
                        ? "border-foreground ring-1 ring-foreground"
                        : "border-border hover:border-border-strong"
                    }`}
                  >
                    <span
                      style={{ backgroundColor: preset.bg, color: preset.text }}
                      className="inline-flex h-5 w-6 flex-none items-center justify-center rounded-[3px] font-mono text-[11px] font-semibold"
                    >
                      Aa
                    </span>
                    <span className="min-w-0 truncate">{preset.label.split(" ")[0]}</span>
                  </button>
                );
              })}
            </div>
          </Row>

          <Separator />

          <Row label="Reader" htmlFor="default-voice"
            hint={settingsDefaultVoice(settings).provider === "elevenlabs" && defaultReader.provider === "gemini"
              ? "Kore is used until your saved ElevenLabs reader is available."
              : undefined}>
            <VoicePicker
              id="default-voice"
              value={defaultReader}
              onChange={(voice) => save({
                defaultVoice: voice.name,
                defaultVoiceRef: { provider: voice.provider, id: voice.id },
                defaultVoiceProvider: voice.provider,
                defaultVoiceId: voice.id,
              })}
            />
          </Row>

          <Separator />

          <Row
            label="Gemini model"
            hint="Used when you choose a Gemini reader."
            htmlFor="default-gemini-model"
          >
            <Select
              value={settings.defaultGeminiModel}
              onValueChange={(value) => save({ defaultGeminiModel: value as TTSModelName })}
            >
              <SelectTrigger id="default-gemini-model" className="w-full">
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
          </Row>

          {defaultReader.provider !== "elevenlabs" ? (
            <>
              <Separator />
              <Row label="Delivery" hint="How the reader should sound by default." htmlFor="default-style">
                <DefaultPresetSelect
                  id="default-style"
                  presets={deliveryPresets}
                  text={settings.defaultPromptStyle}
                  onChange={(text) => save({ defaultPromptStyle: text })}
                />
              </Row>
            </>
          ) : null}

          <Separator />

          <Row
            label="Rewrite for the ear"
            hint="Turn written structure into something that sounds natural read aloud."
            htmlFor="default-rewrite"
          >
            <div className="justify-self-end">
              <Switch
                id="default-rewrite"
                checked={settings.rewriteForNarration}
                onCheckedChange={(checked) => save({ rewriteForNarration: checked })}
              />
            </div>
          </Row>

          <Separator />

          <Row label="Custom instructions" hint="What the rewrite starts with." htmlFor="default-instructions">
            <DefaultPresetSelect
              id="default-instructions"
              presets={instructionPresets}
              text={settings.defaultRewriteInstructions}
              onChange={(text) => save({ defaultRewriteInstructions: text })}
            />
          </Row>

          <Separator />

          <Row
            label="Clean document structure"
            hint="Format headings, fences, tables, and Mermaid charts."
            htmlFor="default-structure"
          >
            <div className="justify-self-end">
              <Switch
                id="default-structure"
                checked={settings.structureMarkdown}
                onCheckedChange={(checked) => save({ structureMarkdown: checked })}
              />
            </div>
          </Row>

          <Separator />

          <Row
            label="Verbalize diagrams"
            hint="Translate Mermaid and ASCII diagrams into spoken descriptions."
            htmlFor="default-verbalize"
          >
            <div className="justify-self-end">
              <Switch
                id="default-verbalize"
                checked={settings.verbalizeDiagrams}
                onCheckedChange={(checked) => save({ verbalizeDiagrams: checked })}
              />
            </div>
          </Row>

          <Separator />

          <Row label="Delivery presets" hint="Saved from the composer. Narrations keep their text if a preset is deleted." htmlFor="delivery-presets">
            <div id="delivery-presets" className="min-w-0">
              <PresetList label="Delivery" presets={settings.deliveryPresets}
                onDelete={(id) => save({ deliveryPresets: settings.deliveryPresets.filter((preset) => preset.id !== id) })} />
            </div>
          </Row>

          <Separator />

          <Row label="Instruction presets" hint="Saved from the composer." htmlFor="instruction-presets">
            <div id="instruction-presets" className="min-w-0">
              <PresetList label="Instruction" presets={settings.instructionPresets}
                onDelete={(id) => save({ instructionPresets: settings.instructionPresets.filter((preset) => preset.id !== id) })} />
            </div>
          </Row>

          <Separator />

          <Row label="Start playing automatically" htmlFor="default-autoplay">
            <div className="justify-self-end">
              <Switch
                id="default-autoplay"
                checked={settings.autoPlay}
                onCheckedChange={(checked) => save({ autoPlay: checked })}
              />
            </div>
          </Row>

          <Separator />

          <Row label="Who can listen" hint="The default for anything new." htmlFor="default-visibility">
            <Select
              value={settings.defaultVisibility}
              onValueChange={(value) => save({ defaultVisibility: value as Visibility })}
            >
              <SelectTrigger id="default-visibility" className="w-full">
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
          </Row>
        </div>

        <Separator />

        <Row label="Connected apps" hint="Command-line tools and coding agents that can create private narrations for you." htmlFor="connected-apps">
          <div id="connected-apps" className="min-w-0">
            <ConnectedApps />
          </div>
        </Row>

        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void signOutUser()}
            className="gap-2 rounded-full"
          >
            <LogOut size={15} strokeWidth={2} />
            Sign out
          </Button>
        </div>
    </WorkbenchPanel>
  );
}
