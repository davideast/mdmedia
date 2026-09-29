export interface ElevenLabsVoice {
  id: string;
  name: string;
}

interface VoicePage {
  voices: Array<{ voice_id: string; name: string }>;
  has_more: boolean;
  next_page_token?: string | null;
}

/** Looks up the IDs required by ElevenLabs from account-visible voice names. */
export class ElevenLabsVoiceCatalog {
  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch
  ) {
    if (!apiKey.trim()) throw new Error('ELEVENLABS_API_KEY environment variable is required.');
  }

  async list(search?: string): Promise<ElevenLabsVoice[]> {
    const voices = new Map<string, ElevenLabsVoice>();
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;

    while (true) {
      const url = new URL('https://api.elevenlabs.io/v2/voices');
      url.searchParams.set('page_size', '100');
      url.searchParams.set('include_total_count', 'false');
      if (search) url.searchParams.set('search', search);
      if (nextPageToken) url.searchParams.set('next_page_token', nextPageToken);

      const response = await this.request(url, { headers: { 'xi-api-key': this.apiKey } });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if ((response.status === 401 || response.status === 403) && body.includes('voices_read')) {
          throw new Error(
            'ElevenLabs voice names require an API key with voices_read permission. ' +
            'Use a voice ID or enable that permission for voice listing.'
          );
        }
        throw new Error(`ElevenLabs voice listing failed (HTTP ${response.status}).`);
      }

      const page = (await response.json()) as VoicePage;
      if (!Array.isArray(page.voices)) {
        throw new Error('ElevenLabs returned an invalid voice list.');
      }
      for (const voice of page.voices) {
        if (typeof voice.voice_id !== 'string' || typeof voice.name !== 'string') {
          throw new Error('ElevenLabs returned an invalid voice list.');
        }
        voices.set(voice.voice_id, { id: voice.voice_id, name: voice.name });
      }

      if (!page.has_more) break;
      const token = page.next_page_token;
      if (!token || seenTokens.has(token)) {
        throw new Error('ElevenLabs returned an invalid voice list page token.');
      }
      seenTokens.add(token);
      nextPageToken = token;
    }

    return [...voices.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
  }

  async resolve(reference: string): Promise<string> {
    const value = reference.trim();
    if (!value) throw new Error('An ElevenLabs voice name or ID is required.');
    if (value.startsWith('id:')) {
      const id = value.slice(3).trim();
      if (!id) throw new Error('An ElevenLabs voice ID is required after id:.');
      return id;
    }
    // Current ElevenLabs IDs are 20-character alphanumeric strings. Explicit id: also works.
    if (/^[A-Za-z0-9]{20}$/.test(value)) return value;

    const name = value.startsWith('name:') ? value.slice(5).trim() : value;
    if (!name) throw new Error('An ElevenLabs voice name is required after name:.');
    const voices = await this.list(name);
    const normalizedName = name.toLocaleLowerCase();
    const exactMatches = voices.filter(
      (voice) => voice.name.toLocaleLowerCase() === normalizedName
    );
    const matches = exactMatches.length > 0
      ? exactMatches
      : voices.filter((voice) =>
          voice.name.split(/\s+[-–—]\s+/, 1)[0]?.toLocaleLowerCase() === normalizedName
        );
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      throw new Error(
        `Multiple ElevenLabs voices match "${name}". Use a voice ID: ` +
        matches.map((voice) => voice.id).join(', ')
      );
    }
    throw new Error(`No ElevenLabs voice named "${name}". Run mdmedia voices to list available voices.`);
  }
}
