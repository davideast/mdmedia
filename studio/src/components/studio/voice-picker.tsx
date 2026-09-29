"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { auth } from "@/lib/firebase";
import { DAVID_EAST_VOICE, VOICE_PROVIDER_LABEL, VOICES, type VoiceChoice } from "@/lib/types";

interface VoicePage {
  voices: Array<{ id: string; name: string }>;
  hasMore: boolean;
  nextPageToken?: string;
}

async function searchElevenLabsVoices(
  search: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<VoicePage> {
  const token = await auth().currentUser?.getIdToken();
  if (!token) throw new Error("Sign in to browse ElevenLabs voices.");
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/voices?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error("Could not load ElevenLabs voices.");
  return response.json() as Promise<VoicePage>;
}

function VoiceRow({
  voice,
  selected,
  onSelect,
}: {
  voice: VoiceChoice;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <span className="min-w-0 flex-1 truncate" title={voice.name}>{voice.name}</span>
      <span className="shrink-0 text-[0.7rem] text-ink-muted">
        {VOICE_PROVIDER_LABEL[voice.provider]}
      </span>
      {selected ? <Check size={14} aria-hidden="true" /> : null}
    </button>
  );
}

/** One searchable voice control for Studio and the user's default reader. */
export function VoicePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: VoiceChoice;
  onChange: (voice: VoiceChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<VoiceChoice[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setRemote([]);
    setCursor(undefined);
    setError("");
    setLoading(true);
    const timer = setTimeout(() => {
      void searchElevenLabsVoices(query.trim(), undefined, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setRemote(page.voices.map((voice) => ({
            provider: "elevenlabs",
            id: voice.id,
            name: voice.name,
          })));
          setCursor(page.hasMore ? page.nextPageToken : undefined);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("ElevenLabs voices could not load.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, query ? 250 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  const loadMore = async () => {
    if (!cursor || loading) return;
    const search = query.trim();
    setLoading(true);
    try {
      const page = await searchElevenLabsVoices(search, cursor);
      if (queryRef.current.trim() !== search) return;
      setRemote((current) => {
        const known = new Set(current.map((voice) => voice.id));
        return [...current, ...page.voices
          .filter((voice) => !known.has(voice.id))
          .map((voice) => ({ provider: "elevenlabs" as const, id: voice.id, name: voice.name }))];
      });
      setCursor(page.hasMore ? page.nextPageToken : undefined);
    } catch {
      if (queryRef.current.trim() === search) setError("More voices could not load.");
    } finally {
      if (queryRef.current.trim() === search) setLoading(false);
    }
  };

  const needle = query.trim().toLocaleLowerCase();
  const geminiVoices: VoiceChoice[] = VOICES
    .filter((voice) => voice.toLocaleLowerCase().includes(needle))
    .map((voice) => ({ provider: "gemini", id: voice, name: voice }));
  const featured = DAVID_EAST_VOICE.name.toLocaleLowerCase().includes(needle)
    ? [DAVID_EAST_VOICE]
    : [];
  const visibleRemote = [...featured, ...remote.filter((voice) => voice.id !== DAVID_EAST_VOICE.id)];
  if (
    value.provider === "elevenlabs" &&
    !visibleRemote.some((voice) => voice.id === value.id) &&
    value.name.toLocaleLowerCase().includes(needle)
  ) visibleRemote.unshift(value);

  const choose = (voice: VoiceChoice) => {
    onChange(voice);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={`Reader: ${value.name}, ${VOICE_PROVIDER_LABEL[value.provider]}`}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="min-w-0 flex-1 truncate">{value.name}</span>
          <span className="shrink-0 text-[0.7rem] text-ink-muted">
            {VOICE_PROVIDER_LABEL[value.provider]}
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(25rem,calc(100vw-2rem))] p-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search voices"
          aria-label="Search voices"
          autoFocus
        />
        <div className="mt-2 max-h-72 overflow-y-auto">
          {visibleRemote.map((voice) => (
            <VoiceRow
              key={`elevenlabs:${voice.id}`}
              voice={voice}
              selected={value.provider === voice.provider && value.id === voice.id}
              onSelect={() => choose(voice)}
            />
          ))}
          {geminiVoices.map((voice) => (
            <VoiceRow
              key={`gemini:${voice.id}`}
              voice={voice}
              selected={value.provider === voice.provider && value.id === voice.id}
              onSelect={() => choose(voice)}
            />
          ))}
          {loading ? <p className="px-2 py-2 text-xs text-ink-muted">Loading ElevenLabs voices…</p> : null}
          {error ? <p className="px-2 py-2 text-xs text-destructive">{error}</p> : null}
          {cursor ? (
            <button type="button" onClick={() => void loadMore()} disabled={loading} className="w-full rounded-md px-2 py-2 text-left text-sm text-foreground hover:bg-accent disabled:opacity-50">
              Show more ElevenLabs voices
            </button>
          ) : null}
          {!loading && !error && visibleRemote.length === 0 && geminiVoices.length === 0 ? (
            <p className="px-2 py-2 text-xs text-ink-muted">No voices found.</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
