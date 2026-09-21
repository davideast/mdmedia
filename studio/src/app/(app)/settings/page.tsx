"use client";

import { useTransition } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useNarration } from "@/components/shell/narration-provider";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useAuth } from "@/lib/auth-context";
import {
  DEFAULT_SETTINGS,
  HIGHLIGHT_COLORS,
  VOICES,
  type HighlightColorId,
  type UserSettings,
  type Visibility,
  type VoiceName,
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
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,18rem)] items-center gap-6">
      <div className="grid gap-1">
        <Label htmlFor={htmlFor} className="t-card-title font-normal">
          {label}
        </Label>
        {hint === undefined ? null : <p className="t-meta">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const { profile, updateSettings, signOutUser } = useAuth();
  const { highlightColor, setHighlightColor } = useNarration();
  const { theme, setTheme } = useTheme();
  const [pending, startTransition] = useTransition();

  const settings: UserSettings = profile?.settings ?? DEFAULT_SETTINGS;

  const save = (patch: Partial<UserSettings>) => {
    startTransition(async () => {
      try {
        await updateSettings(patch);
      } catch {
        toast.error("That setting did not save. Try again.");
      }
    });
  };

  return (
    <WorkbenchPanel
      title="Settings"
      icon={<SettingsIcon size={13} strokeWidth={2} />}
      bodyClassName="p-0"
    >
      <div className="mx-auto grid w-full max-w-[52rem] gap-8 p-8">
        <p className="t-lead">These apply to every new narration you start.</p>

        <div className="grid gap-6">
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
            <div id="highlight-color" className="grid grid-cols-3 gap-2">
              {HIGHLIGHT_COLORS.map((preset) => {
                const selected = highlightColor === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setHighlightColor(preset.id as HighlightColorId)}
                    className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[0.78rem] transition-all ${
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
                    <span className="truncate">{preset.label.split(" ")[0]}</span>
                  </button>
                );
              })}
            </div>
          </Row>

          <Separator />

          <Row label="Reader" htmlFor="default-voice">
            <Select
              value={settings.defaultVoice}
              disabled={pending}
              onValueChange={(value) => save({ defaultVoice: value as VoiceName })}
            >
              <SelectTrigger id="default-voice" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {VOICES.map((voice) => (
                  <SelectItem key={voice} value={voice}>
                    {voice}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Separator />

          <Row label="Delivery" hint="How the reader should sound." htmlFor="default-style">
            <Textarea
              id="default-style"
              defaultValue={settings.defaultPromptStyle}
              rows={3}
              className="resize-none"
              onBlur={(event) => {
                if (event.target.value !== settings.defaultPromptStyle) {
                  save({ defaultPromptStyle: event.target.value });
                }
              }}
            />
          </Row>

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
                disabled={pending}
                onCheckedChange={(checked) => save({ rewriteForNarration: checked })}
              />
            </div>
          </Row>

          <Separator />

          <Row label="Start playing automatically" htmlFor="default-autoplay">
            <div className="justify-self-end">
              <Switch
                id="default-autoplay"
                checked={settings.autoPlay}
                disabled={pending}
                onCheckedChange={(checked) => save({ autoPlay: checked })}
              />
            </div>
          </Row>

          <Separator />

          <Row label="Who can listen" hint="The default for anything new." htmlFor="default-visibility">
            <Select
              value={settings.defaultVisibility}
              disabled={pending}
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

        <div className="pt-2">
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
      </div>
    </WorkbenchPanel>
  );
}
