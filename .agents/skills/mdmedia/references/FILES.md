# Files: generate media on disk

These commands call Gemini or ElevenLabs directly and write a file. Keys come
from the environment, a `.env` in the working directory, or `.mdmedia.json`.
A missing key is an error; tell the user which variable to set.

Always pass `-o` with a path the user asked for, or a clearly named one in
the working directory. Report the path afterwards. Run `mdmedia <command> --help`
for any flag not listed here.

| Command | Makes | Core usage |
| --- | --- | --- |
| `audio` | Narration `.wav` | `mdmedia audio -i doc.md -o doc.wav` |
| `adapt` | Ear-friendly script `.md` | `mdmedia adapt -i doc.md -o doc.script.md` |
| `video` | Clip `.mp4` from a storyboard | `mdmedia video -i storyboard.md -o scene.mp4` |
| `image` | `.png` / `.jpg` | `mdmedia image -p "…" -o out.png` |
| `music` | Song or score `.mp3` / `.wav` | `mdmedia music -p "…" -o song.mp3` |
| `sfx` | Sound effect `.mp3` / `.wav` | `mdmedia sfx -p "…" -o sound.mp3` |
| `voices` | Lists ElevenLabs voices | `mdmedia voices --search "<name>"` |

## audio

- `-v, --voice`: a Gemini voice name, like Kore or Puck, or an ElevenLabs name or id.
- `--provider gemini|elevenlabs`.
- `-s, --style "<delivery>"`: Gemini only.
- `-m, --model`.
- `-n, --narration`: rewrite for listening before speaking.
- `-p, --play`: stream to the speakers while generating.

For a long document the user wants rewritten, consider running `adapt` first,
so they can read the script before audio is made.

## video

The storyboard is markdown:
- `# Scene` headers;
- timecodes like `[0-3s] …`;
- image tags `<FIRST_FRAME> path` and `<IMAGE_REF_0> path`.

Image paths resolve relative to the storyboard, and a missing image is an error.

Flags:
- `-a 16:9|9:16`
- `--firstFrame img`
- `-r a.png,b.png` for reference images
- `-t text_to_video|image_to_video|reference_to_video|edit`
- `--interactionId <id>` to edit a previous result step by step

## image

- `-p "<prompt>"` or `-i prompt.md`.
- `-r style.png`: match the style of a reference image.
- `-a 16:9|1:1|4:3|3:2`.
- `--size 1K|2K|4K`.

## music

- `-p "<prompt>"` or `-i lyrics.md`.
- `--clip`: a 30-second preview, which is cheaper. Use it when the user is exploring.
- `-f mp3|wav`.
- `-r img.png`: music inspired by an image.

## sfx

- `-p "<prompt>"`.
- `-d <seconds 0.5–30>`.
- `--loop`: a seamless loop.
- `--influence 0–1`: how literally to follow the prompt (default 0.3).
