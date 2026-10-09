"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ONE_OFF, createPreset, selectedPresetId } from "@/lib/presets";
import { MAX_PRESET_NAME, type TextPreset } from "@/lib/types";

const NEW_PRESET = "new-preset";

/**
 * Pick a saved block of text, write a one-off, or save what you wrote as a new
 * preset. The draft keeps the text itself, so a narration never depends on a
 * preset that is later edited or deleted.
 */
export function PresetField({
  id,
  label,
  presets,
  text,
  choice,
  onChange,
  onSave,
  placeholder,
  rows = 3,
  textareaClassName,
}: {
  id: string;
  label: string;
  presets: readonly TextPreset[];
  text: string;
  choice: string | undefined;
  onChange: (next: { text: string; choice: string }) => void;
  onSave: (preset: TextPreset) => void;
  placeholder?: string;
  rows?: number;
  textareaClassName?: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const selected = selectedPresetId(presets, text, choice);
  const oneOff = selected === ONE_OFF;

  const choose = (value: string) => {
    if (value === NEW_PRESET) {
      onChange({ text, choice: ONE_OFF });
      setNaming(true);
      return;
    }
    setNaming(false);
    const preset = presets.find((item) => item.id === value);
    onChange(preset ? { text: preset.text, choice: preset.id } : { text, choice: ONE_OFF });
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || !text.trim()) return;
    const preset = createPreset(trimmed, text);
    onSave(preset);
    onChange({ text: preset.text, choice: preset.id });
    setNaming(false);
    setName("");
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="t-label">{label}</Label>
      <Select value={naming ? NEW_PRESET : selected} onValueChange={choose}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presets.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={ONE_OFF}>One-off (this narration only)</SelectItem>
          <SelectItem value={NEW_PRESET}>New preset…</SelectItem>
        </SelectContent>
      </Select>

      {oneOff ? (
        <Textarea
          id={`${id}-text`}
          aria-label={`${label} text`}
          value={text}
          onChange={(event) => onChange({ text: event.target.value, choice: ONE_OFF })}
          rows={rows}
          className={`resize-none ${textareaClassName ?? ""}`}
          placeholder={placeholder}
        />
      ) : (
        <p title={text} className={`rounded-md border border-border bg-surface-inset px-3 py-2 text-[0.78rem] text-ink-muted ${textareaClassName ?? ""}`}>
          <span className="line-clamp-4 whitespace-pre-wrap">{text || placeholder}</span>
        </p>
      )}

      {naming ? (
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Name for the new ${label.toLowerCase()} preset`}
            value={name}
            maxLength={MAX_PRESET_NAME}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); save(); }
              if (event.key === "Escape") { event.preventDefault(); setNaming(false); }
            }}
            placeholder="Preset name"
            className="h-8"
          />
          <Button type="button" size="sm" onClick={save} disabled={!name.trim() || !text.trim()}>Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        </div>
      ) : oneOff ? (
        <Button type="button" size="sm" variant="ghost" disabled={!text.trim()} onClick={() => setNaming(true)}
          className="h-7 justify-self-start px-2 text-[0.78rem] text-ink-muted">
          Save as preset
        </Button>
      ) : (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ text, choice: ONE_OFF })}
          className="h-7 justify-self-start px-2 text-[0.78rem] text-ink-muted">
          Edit as one-off
        </Button>
      )}
    </div>
  );
}
