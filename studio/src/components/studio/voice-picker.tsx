"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Pause, Play, Star, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/lib/auth-context";
import { auth } from "@/lib/firebase";
import { DEFAULT_SETTINGS, DEFAULT_TTS_MODEL, VOICE_PROVIDER_LABEL, type VoiceChoice, type VoiceRef } from "@/lib/types";
import { visibleVoiceOptions, type PreviewVoice, type VoiceFilter } from "@/lib/voice-options";

interface VoicePage {
  voices: PreviewVoice[];
  hasMore: boolean;
  nextPageToken?: string;
}

const PROVIDER_FILTERS: ReadonlyArray<{ value: VoiceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "gemini", label: "Gemini" },
  { value: "elevenlabs", label: "ElevenLabs" },
];

async function authorizedVoiceFetch(path: string, signal?: AbortSignal): Promise<Response> {
  const token = await auth().currentUser?.getIdToken();
  if (!token) throw new Error("Sign in to sample voices.");
  return fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal });
}

async function searchElevenLabsVoices(search: string, cursor?: string, signal?: AbortSignal): Promise<VoicePage> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (cursor) params.set("cursor", cursor);
  const response = await authorizedVoiceFetch(`/api/voices?${params}`, signal);
  if (!response.ok) throw new Error("Could not load ElevenLabs voices.");
  return response.json() as Promise<VoicePage>;
}

function VoiceRow({ voice, selected, isDefault, isPinned, previewState, onSelect, onPin, onPreview }: {
  voice: PreviewVoice;
  selected: boolean;
  isDefault: boolean;
  isPinned: boolean;
  previewState: "loading" | "playing" | "paused" | null;
  onSelect: () => void;
  onPin: () => void;
  onPreview: () => void;
}) {
  const Icon = previewState === "loading" ? LoaderCircle : previewState === "playing" ? Pause : Play;
  const previewAction = previewState === "loading" ? "Cancel"
    : previewState === "playing" ? "Pause"
    : previewState === "paused" ? "Resume" : "Play";
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_2.75rem_2.75rem] items-center rounded-lg ${selected ? "bg-accent/70" : "hover:bg-accent/50"}`}>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Select ${voice.name}, ${VOICE_PROVIDER_LABEL[voice.provider]}${isDefault ? ", your default" : ""}`}
        onClick={onSelect}
        className="flex min-h-14 min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={voice.name}>{voice.name}</span>
          <span className="block text-xs text-ink-muted">
            {isDefault ? "Default · " : ""}{voice.source === "personal" ? "Personal · " : ""}{VOICE_PROVIDER_LABEL[voice.provider]}
          </span>
        </span>
        <span className="flex w-5 shrink-0 justify-center" aria-hidden="true">
          {selected ? <Check size={16} /> : null}
        </span>
      </button>
      <button type="button" aria-label={`${isPinned ? "Unpin" : "Pin"} ${voice.name}`}
        aria-pressed={isPinned} title={isPinned ? "Unpin voice" : "Pin voice"} onClick={onPin}
        className="flex size-11 items-center justify-center rounded-lg text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Star size={18} fill={isPinned ? "currentColor" : "none"} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={`${previewAction} sample of ${voice.name}`}
        aria-pressed={previewState === "playing"}
        title={`${previewAction} sample`}
        onClick={onPreview}
        className="flex size-11 items-center justify-center rounded-lg text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon size={18} className={previewState === "loading" ? "animate-spin" : ""} aria-hidden="true" />
      </button>
    </div>
  );
}

/** One searchable voice control for Studio and the user's default reader. */
export function VoicePicker({ id, value, onChange }: {
  id: string;
  value: VoiceChoice;
  onChange: (voice: VoiceChoice) => void;
}) {
  const isMobile = useIsMobile();
  const { profile, defaultReader, updateSettings } = useAuth();
  const settings = profile?.settings ?? DEFAULT_SETTINGS;
  const model = settings.defaultGeminiModel ?? DEFAULT_TTS_MODEL;
  const defaultVoice = defaultReader;
  const pinnedVoiceRefs: VoiceRef[] = settings.pinnedVoiceRefs ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<VoiceFilter>("all");
  const [remote, setRemote] = useState<PreviewVoice[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "playing" | "paused" | null>(null);
  const queryRef = useRef(query);
  const providerFilterRef = useRef(providerFilter);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewRequestRef = useRef(0);
  const previewUrlsRef = useRef(new Map<string, string | null>());
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const stopPreview = () => {
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current = null;
    }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setPreviewKey(null);
    setPreviewState(null);
  };

  useEffect(() => () => {
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    audioRef.current?.pause();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);

  useEffect(() => {
    if (!open || providerFilter === "gemini") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchElevenLabsVoices(query.trim(), undefined, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setRemote(page.voices.map((voice) => ({ ...voice, provider: "elevenlabs" })));
          setCursor(page.hasMore ? page.nextPageToken : undefined);
        })
        .catch(() => { if (!controller.signal.aborted) setError("ElevenLabs voices could not load."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query, providerFilter]);

  const loadMore = async () => {
    if (!cursor || loading || providerFilter === "gemini") return;
    const search = query.trim();
    const filter = providerFilter;
    setLoading(true);
    try {
      const page = await searchElevenLabsVoices(search, cursor);
      if (queryRef.current.trim() !== search || providerFilterRef.current !== filter) return;
      setRemote((current) => {
        const known = new Set(current.map((voice) => voice.id));
        return [...current, ...page.voices.filter((voice) => !known.has(voice.id))
          .map((voice) => ({ ...voice, provider: "elevenlabs" as const }))];
      });
      setCursor(page.hasMore ? page.nextPageToken : undefined);
    } catch {
      if (queryRef.current.trim() === search && providerFilterRef.current === filter) setError("More voices could not load.");
    } finally {
      if (queryRef.current.trim() === search && providerFilterRef.current === filter) setLoading(false);
    }
  };

  const playPreview = async (voice: PreviewVoice) => {
    const key = `${voice.provider}:${voice.id}`;
    if (previewKey === key && previewState === "playing") {
      audioRef.current?.pause();
      setPreviewState("paused");
      return;
    }
    if (previewKey === key && previewState === "paused") {
      try { await audioRef.current?.play(); }
      catch { stopPreview(); toast.error("This sample could not resume."); }
      return;
    }
    if (previewKey === key && previewState === "loading") { stopPreview(); return; }
    stopPreview();
    setPreviewKey(key);
    setPreviewState("loading");
    const requestId = previewRequestRef.current;
    const controller = new AbortController();
    previewAbortRef.current = controller;
    try {
      let url: string;
      if (voice.provider === "elevenlabs") {
        let previewUrl = voice.previewUrl !== undefined ? voice.previewUrl : previewUrlsRef.current.get(voice.id);
        if (previewUrl === undefined) {
          const response = await authorizedVoiceFetch(`/api/voices?id=${encodeURIComponent(voice.id)}`, controller.signal);
          if (!response.ok) throw new Error("This voice sample could not load.");
          const detail = await response.json() as { previewUrl?: string | null };
          previewUrl = detail.previewUrl ?? null;
          previewUrlsRef.current.set(voice.id, previewUrl);
        }
        if (!previewUrl) throw new Error("No sample is available for this voice.");
        url = previewUrl;
      } else {
        const params = new URLSearchParams({ voice: voice.id, model });
        const response = await authorizedVoiceFetch(`/api/voices/preview?${params}`, controller.signal);
        if (!response.ok) throw new Error("This voice sample could not load.");
        const blob = await response.blob();
        if (controller.signal.aborted || requestId !== previewRequestRef.current) return;
        url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
      }
      if (controller.signal.aborted || requestId !== previewRequestRef.current) return;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplaying = () => { if (requestId === previewRequestRef.current) setPreviewState("playing"); };
      audio.onended = () => { if (requestId === previewRequestRef.current) stopPreview(); };
      audio.onerror = () => {
        if (requestId === previewRequestRef.current) {
          stopPreview();
          toast.error("This sample could not play.");
        }
      };
      await audio.play();
    } catch (cause) {
      if (controller.signal.aborted || requestId !== previewRequestRef.current) return;
      stopPreview();
      toast.error(cause instanceof Error ? cause.message : "This sample could not play.");
    }
  };

  const visibleVoices = visibleVoiceOptions({
    filter: providerFilter,
    query,
    defaultVoice,
    selectedVoice: value,
    pinnedVoiceRefs,
    elevenLabsVoices: remote,
  });

  const togglePin = (voice: VoiceChoice) => {
    const exists = pinnedVoiceRefs.some((ref) => ref.provider === voice.provider && ref.id === voice.id);
    const next = exists
      ? pinnedVoiceRefs.filter((ref) => ref.provider !== voice.provider || ref.id !== voice.id)
      : [...pinnedVoiceRefs, { provider: voice.provider, id: voice.id }].slice(0, 20);
    void updateSettings({ pinnedVoiceRefs: next });
  };

  const choose = (voice: VoiceChoice) => {
    stopPreview();
    onChange({ provider: voice.provider, id: voice.id, name: voice.name });
    setOpen(false);
    queryRef.current = "";
    setQuery("");
    providerFilterRef.current = "all";
    setProviderFilter("all");
  };
  const handleOpenChange = (next: boolean) => {
    if (!next) stopPreview();
    if (next) {
      setRemote([]);
      setCursor(undefined);
      setError("");
      setLoading(providerFilter !== "gemini");
    } else {
      queryRef.current = "";
      setQuery("");
      providerFilterRef.current = "all";
      setProviderFilter("all");
    }
    setOpen(next);
  };
  const handleQueryChange = (next: string) => {
    stopPreview();
    queryRef.current = next;
    setQuery(next);
    setRemote([]);
    setCursor(undefined);
    setError("");
    setLoading(providerFilter !== "gemini");
  };
  const handleFilterChange = (next: VoiceFilter) => {
    if (next === providerFilter) return;
    stopPreview();
    providerFilterRef.current = next;
    setProviderFilter(next);
    setRemote([]);
    setCursor(undefined);
    setError("");
    setLoading(next !== "gemini");
  };
  const trigger = (
    <button id={id} type="button" aria-label={`Reader: ${value.name}, ${VOICE_PROVIDER_LABEL[value.provider]}`}
      className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <span className="min-w-0 flex-1 truncate">{value.name}</span>
      <span className="shrink-0 text-[0.7rem] text-ink-muted">{VOICE_PROVIDER_LABEL[value.provider]}</span>
      <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
    </button>
  );
  const options = (
    <>
      <div className="px-2 pt-2">
        <Input value={query} onChange={(event) => handleQueryChange(event.target.value)} placeholder="Search voices"
          aria-label="Search voices" autoFocus={!isMobile} className="text-base md:text-sm" />
        <div role="group" aria-label="Filter voices by provider"
          className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
          {PROVIDER_FILTERS.map(({ value: filter, label }) => (
            <button key={filter} type="button" aria-pressed={providerFilter === filter}
              onClick={() => handleFilterChange(filter)}
              className={`min-h-11 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9 ${providerFilter === filter
                ? "bg-accent text-foreground shadow-sm"
                : "text-ink-muted hover:bg-accent/50 hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 md:max-h-72">
        {visibleVoices.map((voice) => {
          const key = `${voice.provider}:${voice.id}`;
          return <VoiceRow key={key} voice={voice} selected={value.provider === voice.provider && value.id === voice.id}
            isDefault={defaultVoice.provider === voice.provider && defaultVoice.id === voice.id}
            isPinned={pinnedVoiceRefs.some((ref) => ref.provider === voice.provider && ref.id === voice.id)}
            previewState={previewKey === key ? previewState : null}
            onSelect={() => choose(voice)} onPin={() => togglePin(voice)} onPreview={() => void playPreview(voice)} />;
        })}
        {loading ? <p className="px-3 py-2 text-xs text-ink-muted">Loading ElevenLabs voices…</p> : null}
        {error ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
        {cursor ? <button type="button" onClick={() => void loadMore()} disabled={loading}
          className="min-h-11 w-full rounded-md px-3 py-2 text-left text-sm text-foreground hover:bg-accent disabled:opacity-50">
          Show more ElevenLabs voices
        </button> : null}
        {!loading && !error && visibleVoices.length === 0
          ? <p className="px-3 py-2 text-xs text-ink-muted">No voices found.</p> : null}
      </div>
    </>
  );

  if (isMobile) return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent ref={sheetRef} tabIndex={-1} side="bottom"
        onOpenAutoFocus={(event) => { event.preventDefault(); sheetRef.current?.focus(); }}
        showCloseButton={false}
        className="h-[85dvh] max-h-[44rem] gap-0 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="relative pb-1 pr-14">
          <span aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-border" />
          <SheetTitle>Choose reader</SheetTitle>
          <SheetClose className="absolute right-2 top-3 flex size-11 items-center justify-center rounded-lg text-ink-muted hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X size={20} aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
        </SheetHeader>
        {options}
      </SheetContent>
    </Sheet>
  );
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="flex w-[min(25rem,calc(100vw-2rem))] flex-col gap-0 p-0">
        {options}
      </PopoverContent>
    </Popover>
  );
}
