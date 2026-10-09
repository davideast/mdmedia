# mdmedia

Transform Markdown documents into audio, video, and music, and generate sound effects. Audio narration supports **Gemini TTS** and **ElevenLabs Text to Speech**; sound effects use **ElevenLabs Sound Effects**.

---

## Features

- **Audio Narration (`mdmedia audio`)**: Stream Markdown documents of any length into single `.wav` audio files with zero memory spikes and **real-time speaker playback (`-p, --play`)** while synthesis streams.
- **Video Generation (`mdmedia video`)**: Convert Markdown storyboards, timecoded scenes, and reference images into `.mp4` video clips via **Gemini Omni Flash** (`gemini-omni-flash-preview`), supporting aspect ratio control (`16:9` / `9:16`), Files API URI polling, and stateful multi-turn editing.
- **Sound Effects (`mdmedia sfx`)**: Generate `.mp3` or `.wav` sound effects from a text prompt via **ElevenLabs** (`eleven_text_to_sound_v2`), with duration, prompt influence, and seamless looping controls.
- **Smart Extension Routing**: Run `mdmedia -i doc.md -o out.wav` or `mdmedia -i storyboard.md -o scene.mp4` and let `mdmedia` automatically detect the right multimodal pipeline.

---

## Usage

### 1. Audio Narration (`mdmedia audio`)

Convert a Markdown file to a clean WAV audio file:

```bash
mdmedia audio -i document.md -o output.wav -v Puck
```

#### Real-time live speaker playback
Listen through your system speakers (`afplay` on macOS / `aplay` on Linux) as each chunk streams:

```bash
mdmedia audio -i article.md -o output.wav -v Puck --play
```

#### Direct voice style and delivery
```bash
mdmedia audio -i article.md -v Fenrir -s "Read in an energetic, engaging tone suitable for a tech podcast."
```

#### ElevenLabs narration

Set an [ElevenLabs API key](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), then use a voice name from your account:

```bash
export ELEVENLABS_API_KEY=your_key
mdmedia voices --search George
mdmedia audio -i article.md -o article.wav --provider elevenlabs --voice George
```

Voice names are resolved through ElevenLabs' voice list and require an API key with `voices_read` permission. A TTS-only key can still use a voice ID directly, for example `--voice JBFqnCBsd6RMkjVDRZzb` (George). `mdmedia voices` lists available names and IDs; duplicate names must be selected by ID. ElevenLabs audio is requested as 24 kHz PCM, so the same WAV output and live playback work. `--style` accepts Gemini delivery notes only; ElevenLabs rejects a free-form delivery note rather than speaking it. `--narration` script rewriting still requires `GEMINI_API_KEY`.

---

### 2. Video Generation (`mdmedia video`)

Convert a Markdown storyboard into an `.mp4` video clip:

```bash
mdmedia video -i storyboard.md -o scene.mp4 --aspect 16:9
```

#### Timecoded & multi-scene storyboards (`storyboard.md` syntax)
You can structure storyboards with scene headers (`# Scene`), timecodes (`[0-3s]`), and image reference tags (`<FIRST_FRAME>`, `<IMAGE_REF_0>`):

```markdown
# Scene 1: Portrait Intro
<FIRST_FRAME> ./assets/starting_frame.png
<IMAGE_REF_0> ./assets/character_sheet.png

[0-3s] A studio fashion sequence. Starting with woman <IMAGE_REF_0>, she turns slowly.
[3-6s] Warm golden hour lighting illuminates the room.
```

Image paths in a storyboard are resolved relative to the storyboard file. A referenced image that doesn't exist is an error rather than being skipped.

Generate video with explicit image tags or command-line reference images:
```bash
mdmedia video -i script.md -o action.mp4 --firstFrame start.png --ref character.png
```

`mdmedia image` takes `--size 1K|2K|4K` for the output resolution (the model's default is 1K):
```bash
mdmedia image -p "A pixel art village square" -a 3:2 --size 4K -o village.png
```

#### Stateful Iterative Video Editing
Edit an existing generated video turn-by-turn using its interaction ID:
```bash
mdmedia video -i edit-prompt.md -o edited.mp4 --interactionId v1_abc123
```

---

### 3. Sound Effects (`mdmedia sfx`)

Generate a sound effect from a prompt with your ElevenLabs API key:

```bash
export ELEVENLABS_API_KEY=your_key
mdmedia sfx -p "heavy wooden door creaking open slowly" -o door.mp3 --duration 3
mdmedia sfx -p "gentle rain on a tin roof" -o rain.wav --loop --influence 0.6
```

The output format follows the file extension (`.wav` is generated as 44.1 kHz PCM with a WAV header; anything else is MP3) unless `--format` is set. Without `--duration`, ElevenLabs picks a length. `sfx` always needs the subcommand name: smart extension routing keeps sending `.mp3` outputs to `music`.

---

## Configuration File (`.mdmedia.json`)

If `.mdmedia.json` exists in the working directory, options are loaded automatically. Precedence:
1. CLI flags
2. `.mdmedia.json` file values
3. Environment variables (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `MDMEDIA_TTS_PROVIDER`)
4. Built-in defaults

The CLI loads a `.env` file from the working directory (Node 20.12+ or Bun); variables already set in the shell take priority. `ELEVEN_LABS_KEY` is accepted as an alias for `ELEVENLABS_API_KEY`.

```json
{
  "mode": "audio",
  "audio": {
    "provider": "gemini",
    "voice": "Puck",
    "style": "Speak clearly with an authoritative, calm cadence.",
    "model": "gemini-3.1-flash-tts-preview",
    "play": false
  },
  "video": {
    "model": "gemini-omni-flash-preview",
    "aspectRatio": "16:9",
    "task": "text_to_video",
    "delivery": "uri"
  },
  "sfx": {
    "outputFormat": "mp3",
    "promptInfluence": 0.3,
    "loop": false
  },
  "maxChars": 400,
  "maxRetries": 3
}
```

For ElevenLabs, set `audio.provider` to `"elevenlabs"`, `audio.voice` to a voice name or ID, and optionally `audio.model` (default: `eleven_multilingual_v2`). You can put its key in `audio.apiKey` or `ELEVENLABS_API_KEY`. `ELEVENLABS_VOICE` supplies a default name or ID; the existing `ELEVENLABS_VOICE_ID` also works. A Gemini `audio.model`, voice, or style from the file is ignored when `--provider elevenlabs` overrides a Gemini file configuration.

For sound effects, the `sfx` section accepts `model`, `outputFormat`, `durationSeconds`, `promptInfluence`, `loop`, and `apiKey`. The key is resolved from `--apiKey`, then `sfx.apiKey`, then `audio.apiKey` when `audio.provider` is `"elevenlabs"`, then `ELEVENLABS_API_KEY`. The top-level `apiKey` is a Gemini key and is never sent to ElevenLabs.

---

## CLI Reference

### `mdmedia audio` Options

| Flag | Short | Default | Description |
| :--- | :--- | :--- | :--- |
| `--input` | `-i` | *(required)* | Path to source `.md` file |
| `--output` | `-o` | `output.wav` | Destination path for audio file |
| `--provider` | | `gemini` | `gemini` or `elevenlabs` |
| `--voice` | `-v` | `Kore` for Gemini | Gemini voice name or ElevenLabs voice name/ID (can use `ELEVENLABS_VOICE`) |
| `--style` | `-s` | `undefined` | Gemini delivery note; unsupported with ElevenLabs |
| `--play` | `-p` | `false` | Play audio in real-time through speakers as chunks stream |
| `--maxChars` | `-c` | `400` | Target character threshold for sentence-boundary chunk splits |
| `--model` | `-m` | Provider default | Gemini or ElevenLabs TTS model ID |
| `--apiKey` | `-k` | Provider environment key | Key for the selected TTS provider |

### `mdmedia video` Options

| Flag | Short | Default | Description |
| :--- | :--- | :--- | :--- |
| `--input` | `-i` | *(required)* | Path to source `.md` storyboard file |
| `--output` | `-o` | `output.mp4` | Destination path for `.mp4` video clip |
| `--aspectRatio` | `-a` | `16:9` | Video aspect ratio (`16:9` or `9:16`) |
| `--task` | `-t` | `text_to_video` | Generation task (`text_to_video`, `image_to_video`, `reference_to_video`, `edit`) |
| `--delivery` | | `uri` | Delivery mode (`uri` for Files API polling or `inline`) |
| `--ref` | `-r` | `undefined` | Comma-separated reference image paths |
| `--firstFrame` | | `undefined` | Path to starting image frame |
| `--interactionId` | | `undefined` | Previous interaction ID for stateful video editing |
| `--model` | `-m` | `gemini-omni-flash-preview` | Gemini Omni Flash model endpoint |

### `mdmedia sfx` Options

| Flag | Short | Default | Description |
| :--- | :--- | :--- | :--- |
| `--prompt` | `-p` | | Text describing the sound effect |
| `--input` | `-i` | | File containing the prompt (used when `--prompt` is omitted) |
| `--output` | `-o` | `sfx.mp3` | Destination path for the audio file |
| `--duration` | `-d` | Model choice | Length in seconds, `0.5` to `30` |
| `--influence` | | `0.3` | How closely to follow the prompt, `0` to `1` |
| `--loop` | | `false` | Generate a seamlessly looping effect |
| `--format` | `-f` | From output extension | `mp3` or `wav` |
| `--model` | `-m` | `eleven_text_to_sound_v2` | ElevenLabs sound effects model |
| `--apiKey` | `-k` | `ELEVENLABS_API_KEY` | ElevenLabs API key |

---

## Programmatic TypeScript Usage

### Audio Narration
```typescript
import { GoogleGenAI } from '@google/genai';
import { NodeFileReader, prepareDocumentChunks } from 'mdmedia/chunker';
import { DocumentAudioPipeline, UniversalEventBus } from 'mdmedia/pipeline';
import { GeminiTTSProvider } from 'mdmedia/tts';
import { WavFileStreamSink } from 'mdmedia/audio';

const fileReader = new NodeFileReader();
const chunks = await prepareDocumentChunks(fileReader, 'document.md', 400);

const eventBus = new UniversalEventBus();
const sink = new WavFileStreamSink('output.wav');
sink.attachToEventBus(eventBus);

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const provider = new GeminiTTSProvider(client);
const pipeline = new DocumentAudioPipeline(provider, eventBus);

await pipeline.processDocument(chunks, 'Puck', 'Clear documentary cadence');
```

For ElevenLabs, a TypeScript caller can produce a WAV without setting up the PCM pipeline directly. Set `ELEVENLABS_API_KEY` first:

```typescript
import { runAudioSynthesis } from 'mdmedia';

await runAudioSynthesis({
  input: 'document.md',
  output: 'output.wav',
  provider: 'elevenlabs',
  voice: 'George',
});
```

### Video Generation
```typescript
import { GoogleGenAI } from '@google/genai';
import { NodeFileReader, prepareStoryboardScenes } from 'mdmedia/chunker';
import { DocumentVideoPipeline, UniversalEventBus } from 'mdmedia/pipeline';
import { GeminiOmniVideoProvider, NodeVideoFileWriter } from 'mdmedia/video';

const fileReader = new NodeFileReader();
const scenes = await prepareStoryboardScenes(fileReader, 'storyboard.md');

const eventBus = new UniversalEventBus();
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const videoProvider = new GeminiOmniVideoProvider(client);
const pipeline = new DocumentVideoPipeline(videoProvider, eventBus);

const results = await pipeline.processScenes(scenes, {
  aspectRatio: '16:9',
  task: 'text_to_video',
});

const fileWriter = new NodeVideoFileWriter();
await fileWriter.writeVideoFile('scene.mp4', results[0].videoBytes);
```

---

## Setup & Installation

### Prerequisites
- Node.js 18+ or Bun 1.0+
- A Gemini API key for Gemini generation or an ElevenLabs API key for ElevenLabs narration

> **Note**: mdmedia is an ESM-only package. Use `import` syntax — CommonJS `require()` is not supported.

### Global Installation
```bash
npm install -g mdmedia
# or: bun add -g mdmedia
```

### Run verification test suite
```bash
bun run verify
```

---

## License

MIT — see [LICENSE](./LICENSE) for details.

