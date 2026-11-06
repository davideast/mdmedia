"use client";

import { useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ONE_OFF,
  addPreset,
  createPreset,
  deletePreset,
  duplicatePresetDraft,
  isBuiltInPreset,
  selectedPresetId,
  updatePreset,
} from "@/lib/presets";
import {
  MAX_PRESET_NAME,
  MAX_PRESET_TEXT,
  type TextPreset,
} from "@/lib/types";

const NEW_PRESET = "new-preset";

export interface PresetListProps {
  id: string;
  label: string;
  builtInPresets: readonly TextPreset[];
  savedPresets: readonly TextPreset[];
  defaultText: string;
  onSave: (next: { presets: TextPreset[]; defaultText: string }) => void;
  placeholder?: string;
}

/**
 * Unified selector + inline inspector for managing built-in and saved text
 * presets alongside the active default selection in Settings.
 */
export function PresetList({
  id,
  label,
  builtInPresets,
  savedPresets,
  defaultText,
  onSave,
  placeholder,
}: PresetListProps) {
  const allPresets = [...builtInPresets, ...savedPresets];
  const defaultPresetId = selectedPresetId(allPresets, defaultText, undefined);

  const [mode, setMode] = useState<"inspect" | "create">("inspect");
  const [inspectedId, setInspectedId] = useState<string | undefined>(undefined);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");
  const [syncedSignature, setSyncedSignature] = useState("");

  const activeId =
    mode === "create"
      ? NEW_PRESET
      : inspectedId &&
          (allPresets.some((preset) => preset.id === inspectedId) ||
            (inspectedId === ONE_OFF && defaultPresetId === ONE_OFF))
        ? inspectedId
        : defaultPresetId;

  const activePreset = allPresets.find((preset) => preset.id === activeId);
  const isBuiltIn = activePreset ? isBuiltInPreset(activePreset) : false;
  const isActiveDefault = activePreset
    ? activePreset.id === defaultPresetId
    : activeId === ONE_OFF && defaultPresetId === ONE_OFF;

  const currentSignature =
    mode === "create"
      ? "create"
      : activePreset
        ? `${activePreset.id}\0${activePreset.name}\0${activePreset.text}`
        : `${ONE_OFF}\0${defaultText}`;

  if (syncedSignature !== currentSignature) {
    setSyncedSignature(currentSignature);
    if (mode !== "create") {
      setDraftName(activePreset ? activePreset.name : "");
      setDraftText(activePreset ? activePreset.text : defaultText);
    }
  }

  const startCreate = (initial?: { name: string; text: string }) => {
    setMode("create");
    setSyncedSignature("create");
    setDraftName(initial?.name ?? "");
    setDraftText(initial?.text ?? "");
  };

  const cancelCreate = () => {
    setMode("inspect");
    setSyncedSignature("");
  };

  const handleSelectChange = (value: string) => {
    if (value === NEW_PRESET) {
      startCreate();
      return;
    }
    setMode("inspect");
    setInspectedId(value);
    setSyncedSignature("");
  };

  const startDuplicate = () => {
    if (!activePreset) return;
    const draft = duplicatePresetDraft(activePreset, allPresets);
    startCreate(draft);
  };

  const handleUpdate = () => {
    if (!activePreset || isBuiltIn) return;
    const next = updatePreset(
      savedPresets,
      activePreset.id,
      { name: draftName, text: draftText },
      defaultText,
    );
    onSave(next);
  };

  const handleRevert = () => {
    if (!activePreset) return;
    setDraftName(activePreset.name);
    setDraftText(activePreset.text);
  };

  const handleDelete = () => {
    if (!activePreset || isBuiltIn) return;
    const fallback = builtInPresets[0]?.text ?? "";
    const next = deletePreset(savedPresets, activePreset.id, defaultText, fallback);
    setInspectedId(undefined);
    setSyncedSignature("");
    onSave(next);
  };

  const handleUseAsDefault = () => {
    if (!activePreset) return;
    if (!isBuiltIn) {
      const isDirty = draftName.trim() !== activePreset.name || draftText !== activePreset.text;
      if (isDirty && draftName.trim() && draftText.trim()) {
        const updated = updatePreset(
          savedPresets,
          activePreset.id,
          { name: draftName, text: draftText },
          activePreset.text,
        );
        onSave(updated);
        return;
      }
    }
    onSave({ presets: [...savedPresets], defaultText: activePreset.text });
  };

  const handleCreate = (useAsDefault: boolean) => {
    const trimmedName = draftName.trim();
    if (!trimmedName || !draftText.trim()) return;
    const created = createPreset(trimmedName, draftText);
    const nextPresets = addPreset(savedPresets, created);
    const nextDefaultText = useAsDefault ? created.text : defaultText;
    setMode("inspect");
    setInspectedId(created.id);
    setSyncedSignature("");
    onSave({ presets: nextPresets, defaultText: nextDefaultText });
  };

  const canSaveDraft = Boolean(draftName.trim() && draftText.trim());
  const isSavedDirty =
    Boolean(activePreset && !isBuiltIn) &&
    (draftName.trim() !== activePreset?.name || draftText !== activePreset?.text);

  return (
    <div className="grid min-w-0 gap-2.5">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <Select value={activeId} onValueChange={handleSelectChange}>
          <SelectTrigger id={id} className="w-full min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {savedPresets.length > 0 ? (
              <SelectGroup>
                <SelectLabel>Saved</SelectLabel>
                {savedPresets.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.id === defaultPresetId ? `${preset.name} (Default)` : preset.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
            <SelectGroup>
              {savedPresets.length > 0 ? <SelectLabel>Built-in</SelectLabel> : null}
              {builtInPresets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.id === defaultPresetId ? `${preset.name} (Default)` : preset.name}
                </SelectItem>
              ))}
            </SelectGroup>
            {defaultPresetId === ONE_OFF ? (
              <>
                <SelectSeparator />
                <SelectItem value={ONE_OFF}>Custom default (unsaved)</SelectItem>
              </>
            ) : null}
            <SelectSeparator />
            <SelectItem value={NEW_PRESET}>New preset…</SelectItem>
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => startCreate()}
          aria-label={`New ${label.toLowerCase()} preset`}
          className="h-9 gap-1.5 px-2.5 text-[0.78rem]"
        >
          <Plus size={13} />
          New
        </Button>
      </div>

      {mode === "create" || activeId === ONE_OFF ? (
        <div className="grid min-w-0 gap-3 rounded-md border border-border bg-surface-inset/40 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] uppercase text-ink-muted">
              {mode === "create" ? `New ${label.toLowerCase()} preset` : "Custom default · Unsaved"}
            </span>
          </div>

          <Input
            aria-label={`${label} preset name`}
            value={draftName}
            maxLength={MAX_PRESET_NAME}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="Preset name"
            className="h-8 bg-background/70 text-[0.82rem]"
          />

          <Textarea
            aria-label={`${label} preset text`}
            value={draftText}
            maxLength={MAX_PRESET_TEXT}
            onChange={(event) => setDraftText(event.target.value)}
            rows={6}
            placeholder={placeholder ?? `Write ${label.toLowerCase()} instructions…`}
            className="resize-y bg-background/70 text-[0.82rem] leading-relaxed"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                disabled={!canSaveDraft}
                onClick={() => handleCreate(true)}
                className="h-7 px-2.5 text-[0.76rem]"
              >
                Save & use as default
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canSaveDraft}
                onClick={() => handleCreate(false)}
                className="h-7 px-2.5 text-[0.76rem]"
              >
                Save preset
              </Button>
            </div>
            {mode === "create" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={cancelCreate}
                className="h-7 px-2 text-[0.76rem] text-ink-muted"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : activePreset && isBuiltIn ? (
        <div className="grid min-w-0 gap-3 rounded-md border border-border bg-surface-inset/40 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[0.82rem] font-medium text-foreground">
              {activePreset.name}
            </span>
            <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] uppercase text-ink-muted">
              {isActiveDefault ? "Built-in · Default" : "Built-in"}
            </span>
          </div>

          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-sm border border-border/70 bg-background/60 px-3 py-2.5 text-[0.82rem] leading-relaxed text-ink-muted">
            {activePreset.text}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            {isActiveDefault ? (
              <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] uppercase text-ink-muted">
                Active default
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleUseAsDefault}
                className="h-7 px-2.5 text-[0.76rem]"
              >
                Use as default
              </Button>
            )}

            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={startDuplicate}
              className="h-7 gap-1.5 px-2 text-[0.76rem] text-ink-muted hover:text-foreground"
            >
              <Copy size={12} />
              Duplicate & edit
            </Button>
          </div>
        </div>
      ) : activePreset ? (
        <div className="grid min-w-0 gap-3 rounded-md border border-border bg-surface-inset/40 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] uppercase text-ink-muted">
              {isActiveDefault ? "Saved preset · Default" : "Saved preset"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              aria-label={`Delete ${activePreset.name} preset`}
              className="h-6 gap-1 px-1.5 text-[0.74rem] text-ink-muted hover:text-destructive"
            >
              <Trash2 size={12} />
              Delete
            </Button>
          </div>

          <Input
            aria-label={`${label} preset name`}
            value={draftName}
            maxLength={MAX_PRESET_NAME}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="Preset name"
            className="h-8 bg-background/70 text-[0.82rem]"
          />

          <Textarea
            aria-label={`${label} preset text`}
            value={draftText}
            maxLength={MAX_PRESET_TEXT}
            onChange={(event) => setDraftText(event.target.value)}
            rows={6}
            placeholder={placeholder ?? `Write ${label.toLowerCase()} instructions…`}
            className="resize-y bg-background/70 text-[0.82rem] leading-relaxed"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                disabled={!isSavedDirty || !canSaveDraft}
                onClick={handleUpdate}
                className="h-7 px-2.5 text-[0.76rem]"
              >
                Save changes
              </Button>
              {isSavedDirty ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleRevert}
                  className="h-7 px-2 text-[0.76rem] text-ink-muted"
                >
                  Revert
                </Button>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {!isActiveDefault ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleUseAsDefault}
                  className="h-7 px-2.5 text-[0.76rem]"
                >
                  Use as default
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={startDuplicate}
                className="h-7 gap-1.5 px-2 text-[0.76rem] text-ink-muted hover:text-foreground"
              >
                <Copy size={12} />
                Duplicate & edit
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
