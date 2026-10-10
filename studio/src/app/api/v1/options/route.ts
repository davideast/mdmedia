import { apiError, authenticate, forbiddenScope, hasScope, unauthorized } from "@/lib/api-auth";
import { MAX_MARKDOWN_CHARS } from "@/lib/narration-api";
import { selectedPresetId } from "@/lib/presets";
import { loadUserSettings } from "@/lib/user-settings-server";
import { listAuthorizedVoices } from "@/lib/voice-access";
import {
  DELIVERY_PRESETS,
  INSTRUCTION_PRESETS,
  settingsDefaultVoice,
  TTS_MODELS,
  VOICES,
  type TextPreset,
} from "@/lib/types";

export const runtime = "nodejs";

const presetName = (presets: readonly TextPreset[], text: string) =>
  presets.find((preset) => preset.id === selectedPresetId(presets, text, undefined))?.name ?? null;

/** Everything a client can set on a narration, with this person's defaults and presets. */
export async function GET(request: Request): Promise<Response> {
  const caller = await authenticate(request);
  if (!caller) return unauthorized();
  if (!hasScope(caller, "options:read")) return forbiddenScope("options:read");

  const media = new URL(request.url).searchParams.get('media');
  if (media === 'image') {
    const { imageDefaults, configuredImageModel } = await import('@/lib/image-server');
    const { IMAGE_RATIOS, IMAGE_RESOLUTIONS, MAX_REFERENCE_BYTES, MAX_IMAGE_PROMPT } = await import('@/lib/image-request');
    return Response.json({ type: 'image', available: Boolean(process.env.GEMINI_API_KEY), provider: 'gemini', model: configuredImageModel(),
      defaults: await imageDefaults(caller.uid), capabilities: { aspectRatios: IMAGE_RATIOS, resolutions: IMAGE_RESOLUTIONS, adaptation: true, referenceImages: 1 },
      limits: { promptChars: MAX_IMAGE_PROMPT, referenceBytes: MAX_REFERENCE_BYTES }, visibility: ['private'] }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (media === 'video') {
    const { videoDefaults, configuredVideoModel } = await import('@/lib/video-server');
    const { videoToolsAvailable } = await import('@/lib/video-assets-server');
    const { VIDEO_RESOLUTIONS, MAX_VIDEO_BYTES } = await import('@/lib/video-request');
    return Response.json({ type: 'video', available: Boolean(process.env.GEMINI_API_KEY) && await videoToolsAvailable(), provider: 'gemini', model: configuredVideoModel(),
      defaults: await videoDefaults(caller.uid), capabilities: { aspectRatios: ['16:9', '9:16'], resolutions: VIDEO_RESOLUTIONS, adaptation: true, referenceImages: 1, continuation: true, regenerateLatest: true, audio: true },
      limits: { promptChars: 32000, referenceBytes: 10 * 1024 * 1024, outputBytes: MAX_VIDEO_BYTES, clipSeconds: { min: 3, max: 10 }, sequenceSeconds: null }, visibility: ['private'] }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (media && media !== 'narration') return apiError(400, 'invalid_type', 'Options are available for narration, image, and video.');
  const settings = await loadUserSettings(caller.uid);
  const delivery = [...DELIVERY_PRESETS, ...settings.deliveryPresets];
  const instructions = [...INSTRUCTION_PRESETS, ...settings.instructionPresets];

  let elevenlabs: Array<{ id: string; name: string }> = [];
  try {
    for (let cursor: string | null = null, pages = 0; pages < 10; pages++) {
      const page = await listAuthorizedVoices(caller.uid, "", cursor);
      if (!page) break;
      elevenlabs = elevenlabs.concat(page.voices.map((voice) => ({ id: voice.id, name: voice.name })));
      if (!page.nextPageToken) break;
      cursor = page.nextPageToken;
    }
  } catch (error) {
    console.error("[options] voice list failed:", error);
    return apiError(502, "voices_unavailable", "Could not load available voices.");
  }

  const defaultVoice = settingsDefaultVoice(settings);
  return Response.json({
    voices: {
      gemini: VOICES.map((name) => ({ id: name, name })),
      elevenlabs,
    },
    models: TTS_MODELS,
    visibility: caller.kind === "apiKey" ? ["private"] : ["private", "shared", "public"],
    presets: {
      delivery: delivery.map(({ id, name, text }) => ({ id, name, text })),
      instructions: instructions.map(({ id, name, text }) => ({ id, name, text })),
    },
    defaults: {
      voice: { provider: defaultVoice.provider, id: defaultVoice.id, name: defaultVoice.name },
      model: settings.defaultGeminiModel,
      delivery: settings.defaultPromptStyle,
      deliveryPreset: presetName(delivery, settings.defaultPromptStyle),
      rewriteForNarration: settings.rewriteForNarration,
      instructionsPreset: presetName(instructions, settings.defaultRewriteInstructions),
      structureMarkdown: settings.structureMarkdown,
      verbalizeDiagrams: settings.verbalizeDiagrams,
      visibility: caller.kind === "apiKey" ? "private" : settings.defaultVisibility,
      speed: 1,
    },
    limits: { markdownChars: MAX_MARKDOWN_CHARS, speed: { min: 0.5, max: 2.5 } },
  }, { headers: { "Cache-Control": "no-store" } });
}
