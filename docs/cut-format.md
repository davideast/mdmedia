# Cut files

A cut file is an edit written as data: one JSON file that says which shots
play, in what order, with which lines, music, sound effects and overlays. It
replaces the hand-written ffmpeg script per clip. `mdmedia cut render` compiles
it into the video (see [cut-render.md](cut-render.md)); an editor view reads it
to draw a player and a timeline.

The types are in `src/cut/types.ts`. `resolveCut` (in `src/cut/resolve.ts`)
turns a cut file into a flat timeline and checks it. The worked example is
[`cuts/night-wagon-take9.cut.json`](cuts/night-wagon-take9.cut.json), ported
from `crt/nw9/edit.mjs`. [`cuts/night-wagon-take10.cut.json`](cuts/night-wagon-take10.cut.json)
adds Take 10's ending.

## The file

```json
{
  "format": "mdmedia.cut@1",
  "meta": { "title": "Night Wagon", "show": "night-wagon", "version": "Take 9 (opens on the road)",
            "length": 26.3, "fps": 24, "width": 1280, "height": 720 },
  "media": { "root": "/home/david/.local/share/mdmedia/productions/crt-tv", "takes": "takes/{name}.mp4" },
  "output": "takes/night-wagon-take9.mp4",
  "segments": [ … ],
  "lines": [ … ],
  "music": [ … ],
  "sfx": [ … ],
  "overlays": [ … ],
  "picture": { "fadeOut": 0.5 },
  "mix": { "filters": [ … ] },
  "sources": { … },
  "performances": [ … ],
  "check": { "thresholds": { … } }
}
```

Only `format`, `meta`, `media` and `segments` are required. `meta.length` is
optional; when it is set, the resolver checks that the segments add up to it.

Every item has an `id`: letters, digits and underscores, unique across the
whole file, and not a frame count like `f12` (see below). Most items also take
a `label` for the timeline.

Every port of a CRT TV script in [`cuts/`](cuts) has a test in `test/cuts/`
that checks it against the times a copy of its script printed with ffmpeg
stubbed out: segment starts to 0.001 s, and its volume expressions, fades and
overlay positions sampled against the resolver's helpers.

## Media

`media.root` is the base for every relative path. It can be absolute, or
relative to the cut file's folder. The resolver's `root` option overrides it,
so moving the media means changing one value. The Night Wagon cuts keep theirs
in the CRT TV production's home, `~/.local/share/mdmedia/productions/crt-tv`,
which is also Studio's default (`MDMEDIA_CUT_MEDIA_ROOT` overrides it).

A `src` is one of:

| Form | Meaning |
|---|---|
| `take:nw6-highway-t1` | A generated take, found through `media.takes` (default `takes/{name}.mp4`) |
| `color:black` | A solid picture with no sound |
| `asset:pm3f9c…` | A file stored elsewhere, such as a Studio media asset |
| `audio/tts/b2.wav` | A path under the root |

An `asset:` source is opaque to the resolver: it resolves to
`{ kind: "asset", ref, id }` with no path, and the media root doesn't apply.
Whatever plays or renders the cut maps the id to its bytes; Studio maps it to
one of your media assets. The id is letters, digits, `_` and `-`. A words file
for such a cut records the same `asset:<id>` as each line's `source`, and its
`sha256` is checked against the asset's content hash. `mdmedia production
push` rewrites a cut's sources this way when it uploads its media (see
[the productions API](studio-productions-api.md)). `cutSourceRefs(cut)` lists
every source a cut plays, as written: segments and their sound, lines with
their own sound, music and sfx files and every part of a bed, and overlays.

### Where a source came from: `sources`

`sources` records, by `src` as written, how each source was made. It is
optional and changes nothing in the edit; the resolver passes it through as
`timeline.sources`, with its own sources resolved.

```json
"sources": {
  "take:meridian-full-t2": { "step": "extend", "extendedFrom": "take:meridian-1-t1", "storyboard": "ch-meridian-2" },
  "take:hal5-pat-t1": { "step": "generate", "storyboard": "hal5-pat", "firstFrame": "hal5/stills/hood-insert.png" }
}
```

| Field | Means |
|---|---|
| `step` | `generate` (a fresh generation, from a prompt or a still), `extend` (another take continued, returned as one file), `compose` (our graphics or edit laid over another file) or `swap` (another take's speech converted to a character's voice, the picture and timing unchanged) |
| `extendedFrom` | The take it was extended from (or composed over) |
| `swappedFrom` | For a `swap`: the take whose speech was converted |
| `voice` | For a `swap`: the voice, a character version (`chet@1`) or a voice name |
| `storyboard` | The storyboard (prompt) it was generated from |
| `firstFrame` | The still it was started from |
| `notes` | Anything else |

A voice swap ([characters.md](characters.md#the-voice-swap)) is a new file
with its take's picture and timing, so a cut plays it like any take, and
lines need no swap step of their own. Its provenance matters to the
splitting rule: a source with `swappedFrom` is the same generation as that
take, at the same times, so a sentence cut between a take and its swap is
still one performance.

```json
"voiceswap/booth-close-chet.mp4": { "step": "swap", "swappedFrom": "take:cgl2-booth-close-t1", "voice": "chet@1" }
```

The ported cuts take theirs from the CRT TV production's `gens.log`. In a
variant, `sources` entries replace the base's by source. `mdmedia production
push` uploads the first-frame stills with the cut and rewrites every source it
uploaded to its `asset:` ref; a take it didn't upload (an `extendedFrom` the
cut doesn't play) keeps its `take:` name.

## Times and anchors

A time is a number of seconds on the output timeline, or an anchor string:

| Anchor | Means |
|---|---|
| `"stun"` | stun's start |
| `"stun.end"` | stun's end |
| `"stun+0.4"` | 0.4 s after stun starts |
| `"out-0.5"` | 0.5 s before out starts |
| `"@end-0.45"` | 0.45 s before the cut ends |
| `"@start"` | 0 |

The grammar is `name[.start|.end][±seconds]`, with optional spaces around the
sign. `@start` and `@end` take no `.start` or `.end`; `@end` is the end of the
last segment. Ids can't contain `-` or `.`, so an anchor always reads one way.

### Frames

A time can be written in frames at `meta.fps`: `"f191"` is frame 191, 191 / 24
= 7.958333 s at 24 fps, and an offset can be frames too, as in `"red+f12"`.
Lengths and source times (`in`, `out`, `hold`, `duration`, a sync's `source`)
take the same strings: Meridian's sneer could be
`{ "in": "f191", "out": "f262" }`. Frames are whole numbers, and are read to
the microsecond like every other time. Because `f` and digits read as frames,
no id can look like `f12`.

How each item's start and end are found:

- **Segments** run one after another. A segment starts where the previous one
  ends (the first at 0), unless it has an `at`. Its end is its `end` anchor if
  it has one, else its start plus its length.
- **Lines, music, sound effects and overlays** start at their `at`. They run
  for their natural length (`duration`; for audio, else `out - in`, else the
  probed media length), cut off at `until` if that comes first. With only an
  `until`, they end there.
- **A line from a segment**, and **a clip labelling a segment's sound**, start
  and end with the segment, unless their `at` or `until` says otherwise.
- **A line heard in a clip** follows the clip's clock: its `in` plays at
  `clip.start + (in − clip.in)`, and it ends at its `out`, its `until` or the
  clip's end.
- **A clip placed by a sync point** works out its `in` from its `at`, or its
  start from its `in`.
- **A layer** of a segment's sound is also cut off at the segment's end.
- **Keyframes and anchored fades** (volume, motion, opacity, zoom, a fade's
  `start` or `end`) are placed by the same anchors. Nothing can anchor to them.
- **Inside a segment** (its zoom keys, and an overlay drawn into it), a number
  is seconds from the segment's start, so it moves with the segment; a string
  is an anchor as anywhere else. `0.4` and `"tag+0.4"` are the same time there.

Every item has two points, `id.start` and `id.end`. The resolver computes each
point from the points it refers to. A point that refers back to itself, by any
path, is a `cycle` error that names the path, for example
`x.start → y.start → x.end → x.start`.

Times are rounded to the microsecond. They are not snapped to frames: in the
video, frame k (at k / fps) shows the segment playing at that time, so a
segment from `start` to `end` has the frames from ⌈start · fps⌉ up to
⌈end · fps⌉, and its sound starts on its own sample. A
clip's `in` is a time point too (`id.in`, used inside the resolver only), so a
sync point and a line heard in the clip are worked out with the rest.

## Segments

```json
{ "id": "press", "label": "Hand slams the button", "src": "take:nw6-button-t1", "in": 0.85, "out": 1.35,
  "audio": { "src": "take:nw7-rick-yell-t1", "in": 2.45 } }
```

`in` and `out` are source times. A segment's length is `out - in + hold`, or
its `duration`, or what its `end` anchor makes it. Use only one of `hold`,
`duration` and `end`. Any time past `out - in` freezes the last frame; Take 10
holds the button shot until just after Buddy's line ends:

```json
{ "id": "btn", "src": "take:nw6-button-t1", "in": 1.4, "out": 3.0, "end": "flashers+5.25", "audio": { "volume": 0.3 } }
```

Other fields:

- `crop`: `{ "x": 192, "y": 0, "width": 896, "height": 504 }` in source pixels,
  then scaled to the output size.
- `fadeIn` and `fadeOut`: a picture fade from or to black inside the segment.
- `loop: "pingpong"` plays in→out, out→in, in→out and so on, until the
  segment's `duration` or `end`, which it requires. Take 10 keeps the scanner
  sweeping on the wagon at the edge this way.
- `audio`: by default the segment plays its picture source's own sound over the
  same `in`/`out`. An object changes the `src`, `in`, `out`, `volume` or fades,
  or gives a generated sound with `synth` (below); `false` silences it. Segment
  audio plays once from the segment's start, never holds or loops, and is cut
  at the segment's end.
- `mix`: fades over the segment's whole sound (below).

Buddy's shots are a dashboard picture over a quiet room hum from another take:

```json
{ "id": "b2", "src": "take:nw6-buddy-t2", "in": 1.0, "out": 2.55,
  "audio": { "src": "take:nw7-dash-t1", "in": 0, "volume": 0.7 } }
```

### Still images

A segment with `"still": true` holds a still image (a PNG or JPEG) for its
`duration`, or until its `end` anchor; it has no `in`, `out`, `hold` or
`loop`. RIGG's countdown device and CGL Football's bumper and keys card:

```json
{ "id": "bump", "src": "football/g-bumper-bg.png", "still": true, "duration": 2.2 },
{ "id": "card", "src": "football/g-keys-bg.png", "still": true, "end": "m3b+2.15" }
```

A still has no sound of its own: without an `audio` it is silent, and its
`audio` needs a `src` or a `synth`. It resolves with `still: true`, `in` and
`out` 0 and its whole length as `hold`, so a reader that knows only shots
sees a frozen first frame. Crop, zoom, picture fades and overlays drawn into
it work as for a shot.

### A generated sound as a segment's audio

`audio.synth` gives a segment a generated sound instead of a file, from the
segment's start; its `in` defaults to 0 and its `out` to the segment's length.
RIGG's countdown beep is ffmpeg's `sine=frequency=1950:duration=0.11` (which
plays at 1/8 of full scale), at `volume=0.35`, as each count's own sound:

```json
{ "id": "c0030", "src": "rigg5/device.png", "still": true, "duration": 0.8,
  "audio": { "synth": { "kind": "tone", "frequency": 1950, "gain": 0.125 }, "out": 0.11, "volume": 0.35 },
  "zoom": { "keys": [ { "at": 0, "scale": 1 }, { "at": "c0030.end", "scale": 1.05 } ] } }
```

A `tone` is `gain · sin(2π·frequency·t)`; the `tick` synth is described under
Music below. Either can be a segment's audio or a music or sfx clip.

### A segment's whole sound: `mix` and `layer`

A segment's sound can be more than its own audio: a line, music or sound
effect with `"layer": "<segment id>"` is mixed into it. A layer is cut off at
the segment's end (as if its `until` were the segment's end) and must start
inside it. `mix: { "fadeIn", "fadeOut" }` fades all of it together, own audio
and layers, at the segment's start and end. Big Hal and Regulars faded every
segment's mixed sound this way, 12 and 15 ms, so no splice clicks. Big Hal's
pat insert plays its own thump with PERSONALLY! from its one-word take laid
in, faded with it:

```json
{ "id": "pat", "src": "take:hal5-pat-t1", "in": 1.07, "out": 2.5,
  "audio": { "in": 1.15 }, "mix": { "fadeIn": 0.012, "fadeOut": 0.012 } }
…
{ "id": "personally", "speaker": "Big Hal", "text": "PERSONALLY!", "src": "take:hal5-personally-t2", "in": 0.55, "out": 1.63,
  "at": "pat", "fadeOut": 0.15, "layer": "pat" }
```

A layer's own fades and volume apply first; the segment's mix fades multiply
on top. A resolved layer carries `layer: { segment, start, end, fadeIn,
fadeOut }`, so its gain can be worked out alone (`gainAt`, `lineGainAt`), and
`segmentGainAt` gives a segment's own audio with its mix fades.

### Zoom

`zoom` pushes in on a segment: its picture is scaled about a `focus` point,
which stays where it is on screen. `keys` give the scale (1 is the picture as
framed, and it can't go below 1) at times in the segment, linear between keys
and held before the first and after the last. The focus is in output pixels of
the picture as framed (after any crop), or fractions of it with
`"unit": "fraction"`; without one it is the middle. Drive-In's tag holds still
for 0.4 s, then pushes in 20 % to its end, keeping the far wagon at
(872, 243) where it is:

```json
{ "id": "tag", "src": "take:nwdi-rows-t1", "in": 1.9, "out": 3.5,
  "zoom": { "focus": { "x": 872, "y": 243 }, "keys": [ { "at": 0.4, "scale": 1 }, { "at": "tag.end", "scale": 1.2 } ] } }
```

Its family shot is `{ "keys": [ { "at": 0, "scale": 1 }, { "at": "fam.end", "scale": 1.035 } ] }`,
3.5 % about the middle. Keys must lie inside the segment. A picture point `p`
lands on screen at `focus + (p − focus) · scale`; overlays drawn into the
segment (below) are zoomed with it.

## Lines

A line either carries its own sound (a TTS file, or a stretch of another
take), or is words heard in a segment's own audio (Rick on camera), or in a
music or sound-effect clip (a sung lyric). A line heard in other sound adds
none; it labels the timeline.

```json
{ "id": "getaway", "speaker": "Rick", "text": "They're getting away, Buddy.", "segment": "r1" },
{ "id": "bridge", "speaker": "Buddy", "text": "The bridge ahead is out, Rick.", "src": "audio/tts/b2.wav",
  "at": "b2+0.05", "until": "b2.end", "duration": 1.8576 }
```

`duration` is the file's length. A probe passed to the resolver overrides it.
`until: "b2.end"` cuts the line off with Buddy's shot, as the script did.
A segment line can run past its segment with `until`: "TURBO... BOOST!" is
`"segment": "yell", "until": "press.end"`.

A line with its own sound plays its `src` from `in` (default 0) to `out`
(default the end of the source), so it can be part of another take, laid
anywhere as a J- or L-cut. Bellamy's "Hello, Victoria." is 3.0–4.0 s of Take 5's
doorway shot, heard 1.95 s into the doors:

```json
{ "id": "hello", "speaker": "Rex", "text": "Hello, Victoria.", "src": "take:bel5-s2-t1", "in": 3.0, "out": 4.0,
  "at": "doors+1.95" }
```

Its length is `out - in`, else the source's length (probed, or `duration`)
less `in`, cut off at `until`. Its words are in the take's clock.

A voice laid in from another take is always a line like this, never a sound
effect with a segment line marking it: its words are then timed in the take
that carries them. RIGG's "Need a tension wrench." is 3.6–4.6 s of Rigg's
climax take over the lock insert, with the script's 40 ms fade in and 60 ms
fade out:

```json
{ "id": "wrench", "speaker": "Rigg", "text": "Need a tension wrench.", "src": "take:rigg5-climax-t1", "in": 3.6, "out": 4.6,
  "at": "lock+0.05", "fadeIn": 0.04, "fadeOut": 0.06 }
```

A line with its own sound takes `fadeIn` and `fadeOut` (as music does, below),
and `layer` to be mixed into a segment's sound.

### Lines heard in a clip, and sung lines

A line with `"clip": "<music or sfx id>"` is heard in that clip. It adds no
sound and follows the clip's clock: its `in` and `out` are times in the clip's
source (default: the clip's own), so it plays at `clip.start + (in − clip.in)`
and moving the clip moves it. It is cut off at the clip's end, or its own
`until`, and can't start outside the clip. Breeze's sung lyrics:

```json
{ "id": "wrong", "speaker": "Jingle", "text": "When the day goes wrong,", "clip": "jingle", "in": 4.66, "out": 8.4, "sung": true }
```

`"sung": true` marks any line as sung. `mdmedia cut words` doesn't snap a sung
line's first word to the speech onset (a sung onset isn't speech), doesn't
warn about its loss, and marks its entry `"approximate": true`; a resolved
line has `sung`. Its words are in the clip's source's clock, as for a line
with its own sound; in a clip that is a segment's own sound (below), in that
segment's audio.

`filters` (on a line with its own sound, or on any music or sound effect)
change how it sounds, in list order, before `volume`:

| Filter | Fields |
|---|---|
| `highpass` | `frequency` in Hz: cuts what is below it |
| `lowpass` | `frequency` in Hz: cuts what is above it |
| `crush` | `bits` (1–64) and `mix` (0–1, default 1): fewer bits, mixed with the dry sound |
| `echo` | `inGain` and `outGain` (0–1), `delay` in seconds and `decay` (0–1): one echo |

Buddy through the watch's little speaker, and the off-screen "Hey!" across
the lot:

```json
{ "id": "overhere", "speaker": "Buddy", "text": "Rick. I'm over here.", "src": "audio/tts/di-b4.wav",
  "at": "rw+0.3", "until": "rw.end", "duration": 1.4861, "volume": 1.5,
  "filters": [ { "kind": "highpass", "frequency": 500 }, { "kind": "lowpass", "frequency": 3200 },
               { "kind": "crush", "bits": 10, "mix": 0.25 } ] },
{ "id": "hey", "speaker": "Voice (off-screen)", "text": "Hey!", "src": "audio/tts/di-hey.wav",
  "at": "run+0.12", "until": "run.end", "duration": 0.6037, "volume": 0.8,
  "filters": [ { "kind": "echo", "inGain": 0.8, "outGain": 0.6, "delay": 0.06, "decay": 0.3 } ] }
```

`mdmedia cut render` renders them as ffmpeg's `highpass`, `lowpass`,
`acrusher` and `aecho` (see [cut-render.md](cut-render.md)).

`delivery` (optional, on any line) is how the line is delivered, in words:
a note for whoever generates or checks it. It changes nothing in the edit.
`mdmedia cut check --listen` asks about it, and `mdmedia cut storyboard`
writes it into the shot's storyboard:

```json
{ "id": "wheels", "speaker": "Big Hal", "text": "Wheels!", "segment": "finish", "delivery": "the same loudness and note as \"comes with\"" }
```

`words` (optional) are `{ text, start, end }` in the audio's own clock: the
file's time for TTS, the source take's time for a segment line. The resolver
maps them onto the timeline and drops words outside the line. They usually
come from a words file rather than being written by hand; see below.

## Word timings: the words file

`mdmedia cut words` gives every line real word timings by forced alignment,
and keeps them in a companion file, `<name>.words.json` next to
`<name>.cut.json`, so the cut file stays as you wrote it:

```sh
mdmedia cut words docs/cuts/night-wagon-take9.cut.json [--force] [--root <media root>] [--aligner elevenlabs]
```

For each line it cuts the line's audio window out of its source, in the
source's own clock, as mono 16 kHz WAV (with ffmpeg), aligns it against the
line's `text`, and shifts the words back into the source's clock:

- **A line with its own sound** is its source from the line's `in` (0 for a
  TTS file) for the line's length on the timeline, so a line cut off by
  `until` or its `out` stops there.
- **A segment line** is its segment's audio source from the audio in-point, for
  the line's length. A line that runs past its segment with `until` carries
  on in the same source: "TURBO... BOOST!" runs from the yell into the press,
  which plays the same take in step. If the next segment's sound isn't that
  take in step, the command warns.
- **A line heard in a clip** is the clip's file in the clip's clock, from the
  line's `in`, for its length; in a clip that labels a segment's own sound,
  it is that segment's audio, as for a segment line.

Each entry stores the words (with the aligner's per-word loss), the overall
loss, the line's text, the aligner's name, and a fingerprint of what was
aligned: the source path relative to the media root, the window, the
file's SHA-256, and the method that snapped its first word (below):

```json
"bridge": {
  "text": "The bridge ahead is out, Rick.",
  "aligner": "elevenlabs",
  "fingerprint": { "source": "audio/tts/b2.wav", "start": 0, "end": 1.5, "sha256": "bd34…", "snap": "speech-onset@1" },
  "loss": 0.513,
  "snap": { "aligned": 0.1, "start": 0.06, "onset": 0.06, "floor": -56.1 },
  "words": [
    { "text": "The", "start": 0.06, "end": 0.14, "loss": 0.694 },
    …
  ]
}
```

The aligner starts a line's first word late: on Buddy's clean TTS lines it
says 0.10–0.12 s, on a 20 ms grid, where the speech is audible from 0.06–0.08 s.
Its ends are right. So each line's first word is snapped back to the speech
onset measured in the same window: levels every 10 ms in the speech band
(300–3400 Hz), a threshold 7 dB above the window's own background (its 10th
percentile frame) but never more than 30 dB below its loudest frame, and the
onset is the first frame above it that starts a run of at least 30 ms, so a
click doesn't count. The start only ever moves earlier, by at most 0.10 s, and
never before the window; no other word and no end is touched. The same
threshold works for near-silent TTS and for Rick's takes over road noise. Each
entry records it as `"snap": { "aligned", "start", "onset", "floor" }` (the
aligner's start, the start kept, the onset found or null, and the background
in dBFS), and the fingerprint names the method (`"snap": "speech-onset@1"`),
so a line snapped by another method, or not at all, is realigned once. The
measuring code is in `src/cut/onset.ts`.

A sung line (`"sung": true`) is not snapped: a singer's onset and the
aligner's start on a held note say little about each other. Its entry has no
`snap`, its fingerprint no `snap` method, and it is marked
`"approximate": true`; its loss is recorded but not warned about (Breeze's
sung lyrics align at 0.83–1.84). A line that becomes sung, or stops being
sung, is realigned once.

A run aligns only the lines whose text, window, source file, aligner or
snapping method changed; `--force` redoes them all. The file is written the same way every
time, so an unchanged run leaves it untouched. The command prints each line's
speech on the timeline (first word's start to last word's end), its loss, and
whether it was `fresh` (kept), `aligned`, or `stale` (no usable words, with
the reason). It warns, without failing, when a line's loss is over 0.9 (clean
TTS aligns at about 0.5–0.7, Rick's noisy on-camera lines at about 0.7, the
shouted yell at 1.03) or when it got a different number of words than its text
has. Blank and punctuation-only entries ("...") are dropped.

The media root is `--root`, else `MDMEDIA_CUT_MEDIA_ROOT` (as Studio reads
it), else the cut's `media.root`. The ElevenLabs aligner reads its key from
`ELEVENLABS_API_KEY` or `ELEVEN_LABS_KEY`, and the key needs the
`forced_alignment` permission. ffmpeg is `FFMPEG_PATH`, else `ffmpeg-static`
when it is installed, else `ffmpeg` on the `PATH`.

`applyWords(cut, wordsFile, options)` puts a words file's words on a parsed
cut before it is resolved, so `resolveCut` itself never reads files. It never
uses stale words: a line whose text, window or source file no longer matches
its entry gets no words at all and is listed in `stale`. Pass `sha256` (a
file's hash by path) to compare the audio's contents; lines it can't check are
listed in `unchecked`. Studio's cut viewer loads `<name>.words.json` this way,
and times the gaps between lines from first word to last word.

## Performances

A cut can say which lines must sound like one continuous delivery: a
sentence split over several lines, or a setup and its payoff. Each
performance has an `id` (in the same namespace as every other item), its
`lines` in the order they are spoken, an `intent` and a `delivery`
direction. Big Hal Take 5's two broken performances and its opening:

```json
"performances": [
  { "id": "opening", "lines": ["howdy", "nomoney", "zero", "month"], "intent": "the opening pitch",
    "delivery": "loud, proud and punchy, a steady local pitchman, every selling point at the same energy" },
  { "id": "inspection", "lines": ["every", "personally"], "intent": "one sentence: the inspection and its tag",
    "delivery": "one sentence at one steady, proud energy, with \"Personally!\" as loud as \"by me!\": never mumbled, never shouted or stretched" },
  { "id": "wheels_joke", "lines": ["thisone", "wheels", "comeon"], "intent": "setup and punchline, then the close",
    "delivery": "an ordinary selling point: one breath, no pause before \"wheels\", …" }
]
```

| Field | Means |
|---|---|
| `id` | Letters, digits and underscores, unique across the file |
| `lines` | Its line ids, at least one, in the order they are spoken |
| `intent` | What it is for, e.g. "setup and punchline" |
| `delivery` | How it is delivered |
| `label` | A label; default its intent, else its id |
| `thresholds` | Its own check thresholds (see below), over the cut's |

Performances change nothing in the edit. The resolver checks them: a line
id that names no line is `unknown-line`; a line in two performances, or
twice in one, is `shared-line`; lines out of spoken order are `bad-value`.
A line needn't be in any performance.

### The splitting rule

A sentence, and a setup with its payoff, come from **one generation**:
never part of a sentence as a separate clip, and never a sentence finished
with an extend. The resolver works out which generation each of a
performance's lines is heard in, from its sound's source (a line's own
`src`, or its segment's or clip's audio) and the stretch of it the line's
words span (the whole line without words), and reports each problem on the
resolved performance's `splits`, without failing the cut:

| `code` | When |
|---|---|
| `separate-generations` | Its lines come from more than one generation |
| `across-extend` | A line's speech runs across an extended take's seam |
| `unknown-seam` | A line is in an extended take whose seam can't be placed |
| `mixed-speakers` | Its lines are said by more than one speaker |

An extended take is the take it continued plus a new tail, returned as one
file, so it holds two generations. A source whose `sources` entry has an
`extendedFrom` has its seam at the length of the take it continued: speech
before it is that take's generation (followed back through its own
`extendedFrom`), speech after it a new one. The resolver takes that length
from its `mediaLength` option, so a cut resolved without probing (as Studio's
viewer does) can't place the seam, and says `unknown-seam`; `mdmedia cut
check` probes it. Big Hal's opening is `big-hal-4ab-t2`, extended from
`big-hal-4a-t2` (10.01 s), and every word of Take 5's lines 1–4 ends before
9.73 s: one generation.

Resolved, a performance has its `lines`, `intent`, `delivery`, `speakers`,
`start` and `end` (its first line's start to its last line's end), its own
`thresholds`, its `generations` (each with a `key`, the `source`, its
`part`: `whole`, `original`, `extension` or `unknown`, the `seam` and its
`lines`) and its `splits`. `lineSound(line, segments, clips)` gives any
resolved line's source and the stretch its speech spans.

### Check settings: `check`

`check.thresholds` sets how big a jump `mdmedia cut check` flags, over its
defaults; a performance's own `thresholds` go over the cut's. Each is a
number above 0: `loudness` (LU), `pitch` (semitones), `rate` (a fraction of
the slower line's rate), `pause` (seconds), `roomTone` (dB) and `word`
(LU). See [cut-check.md](cut-check.md).

```json
"check": { "thresholds": { "pause": 0.4, "roomTone": 4 } }
```

## Music, stings and sound effects

`music` and `sfx` hold the same kind of clip: a `src` (or a `synth`, a bed's
`parts`, or a `segment` whose own sound it labels, all below), an `in` offset,
an `at`, and an `until` or `duration`. `volume` is a number or a list of
keyframes, linear between keys and held before the first and after the last.
`fadeIn` and `fadeOut` multiply on top.

Take 9's theme is full under the open, ramps down to 0.18 in the half second
before Rick's first line, rises through the argument, and fades out hard at the halt:

```json
{ "id": "bed", "src": "audio/nw6-theme.mp3", "at": 0, "until": "halt", "fadeOut": 0.12,
  "volume": [
    { "at": "r1-0.5", "value": 1 },
    { "at": "r1", "value": 0.18 },
    { "at": "r5", "value": 0.18 },
    { "at": "halt", "value": 0.35 }
  ] },
{ "id": "sting", "src": "audio/nw6-theme.mp3", "at": "out-0.5", "until": "@end", "fadeOut": 0.9 }
```

These keys match the script's volume expression to within 0.001 at every
point (a test checks this). Lengthen r3 and the ramp still starts at Rick's
first line and still peaks at the halt.

Two keys at the same time make a jump; at that instant the value is the later
key's. Drive-In's second theme bed steps up from 0.18 to 0.3 as the job
starts, rises, and steps down to 0.42 on "Buddy... Buddy?":

```json
"volume": [
  { "at": "sneak", "value": 0.18 }, { "at": "sneak", "value": 0.3 },
  { "at": "lost", "value": 0.7002 }, { "at": "lost", "value": 0.42 }
]
```

Keys may lie outside the clip; only the stretch the clip plays is heard.
Breeze's announcer duck runs from 0.6 s before the line to 2.9 s after it,
past the end of the jingle at the cut to the tow truck, as the script's volume
expression did:

```json
{ "at": "vo-0.6", "value": 0.8 }, { "at": "vo-0.6", "value": 0.16 },
{ "at": "vo+2.9", "value": 0.16 }, { "at": "vo+2.9", "value": 0.8 }
```

A `synth` is a generated sound. Take 10's hazard relay is a `tick`:

```json
{ "id": "tick", "at": "haz", "until": "haz.end", "fadeOut": 0.15,
  "synth": { "kind": "tick", "period": 0.35, "tones": [2300, 1700], "click": 0.03, "decay": 180, "gain": 0.35 } }
```

Every `period` seconds it plays the next tone from `tones` for `click` seconds,
as `gain · sin(2π·f·t) · e^(−decay·u)`, where `t` is time from the clip's start
and `u` is time since the tick began. A `tone` (`{ "kind": "tone",
"frequency": 1950, "gain": 0.125 }`) is a steady `gain · sin(2π·frequency·t)`.

### Fades timed to an anchor

A fade is a number of seconds at the clip's own start or end, or an object
timed to an anchor: `{ "duration": d, "start": anchor }` for a fade in, and
`{ "duration": d, "end": anchor }` for a fade out that reaches silence at the
anchor, whether or not the clip is still playing there. Lines with their own
sound take the same. Regulars' studio laugh fades over the cut's last 0.9 s,
but its file is 5.0 s and runs out 0.118 s before the cut ends, so the file
stops 0.13 of the way down the fade, as the script rendered it:

```json
{ "id": "laugh", "src": "audio/reg3-laugh.mp3", "at": "eddie", "until": "@end", "duration": 5.0,
  "volume": 0.7, "fadeOut": { "duration": 0.9, "end": "@end" } }
```

An anchored fade may run past either end of the clip, so it isn't checked
against the clip's length. Resolved, every clip and every line with its own
sound has `fadeIn` and `fadeOut` (lengths) and `fadeInStart` and `fadeOutEnd`
(timeline times; the item's start and end unless anchored).

### Placed by a sync point

`sync: { "source": s, "at": anchor }` places a clip so the moment `s` seconds
into its file plays at `anchor`. With the clip's `at`, the resolver works out
its `in`; with its `in` (and no `at`), it works out where the clip starts.
RIGG's tension cue starts on the 00:30 count, and its big hit, 7.45 s into the
file, lands on the first montage cut wherever that falls:

```json
{ "id": "tension", "src": "audio/rigg5-tension.mp3", "at": "c0030", "sync": { "source": 7.45, "at": "lock" }, "until": "turn" }
```

Its `in` comes out at 7.45 − (10.93 − 4.58) = 1.1, the script's `TOFF`.
Lengthen the premise and the in-point moves with it; an `in` below 0 is a
`negative-in` error. A resolved clip has `sync: { source, at }` (the anchor's
time), or null.

### A bed of several passes: `parts`

A clip with `parts` instead of a `src` is one sound made of passes played one
after another, under one `volume` curve and one pair of fades. Each part has a
`src`, an `in` and `out` (default the whole source; `duration` when nothing is
probed) and a `crossfade`: how long it overlaps the part before it, the one
fading out as the other fades in, linearly (ffmpeg's `acrossfade`). The clip's
`in` is seconds into the bed, and its natural length the bed's. CGL Football's
crowd is three passes of its 20 s file:

```json
{ "id": "crowd", "at": "stad-0.2", "until": "outro+1.8", "fadeIn": 0.5, "fadeOut": 1.2,
  "parts": [
    { "src": "audio/fb-crowd.mp3", "in": 0, "out": 20 },
    { "src": "audio/fb-crowd.mp3", "in": 0, "out": 20, "crossfade": 2 },
    { "src": "audio/fb-crowd.mp3", "in": 0, "out": 20, "crossfade": 2 }
  ],
  "volume": [ { "at": "m1-0.15", "value": 0.13 }, { "at": "m1", "value": 0.091 }, … ] }
```

The resolved clip's `src` is `{ "kind": "bed", "parts": 3 }`, and its `parts`
list each pass on the timeline, cut to the clip's span, with its crossfades as
its own `fadeIn` and `fadeOut`. A part's sound is `bedPartGainAt(part, t)`
times the bed's `gainAt(clip, t)`.

### Sound inside a take, labelled

A clip with a `segment` and no sound of its own labels a stretch of that
segment's own audio, as a segment line does for speech: Palm Court's theme
and laugh track, Meridian's klaxon and Barnstormers' music are all in their
takes. It runs from the segment's start to its end unless `at` or `until` say
otherwise, and can run on into the next segments with `until`:

```json
{ "id": "klaxon", "label": "The red-alert klaxon, in the take's own sound", "segment": "red", "until": "@end" }
```

It adds no sound, so it takes no `src`, `in`, `out`, `volume`, fades,
filters, `sync` or `layer`, and `gainAt` is 0 for it. Resolved, it has
`segment` set, the segment's audio as its `src`, its `in` and `out` in that
audio's clock, and the segment's volume as its one volume key. It must start
inside its segment, which must have sound. A sung line can be heard in it:
Clap-Lite's jingle is a music clip labelling the boy's shot's sound, and its
words a sung line with `"clip": "clap_jingle"`.

## Overlays

A PNG over the picture, from `at` to `until` (or for `duration`), drawn in
list order. Both ends are included: an overlay is drawn on every frame at a
time `t` with `start ≤ t ≤ end`, as ffmpeg's `enable='between(t,start,end)'`
does, so an overlay until 14.0 s is on the frame at 14.0 s (frame 336 at
24 fps), the first frame of whatever starts there. Big Hal's HAND-INSPECTED!
runs until the pat starts and shows on its first frame. `overlayShownAt`,
`opacityAt` and `framesIn(start, end, fps)` (the first and last frame) all
read it this way; an overlay with a fade out is at 0 on that last frame.
An overlay in a segment is part of that segment's picture, so it is never
drawn on the next segment's first frame.

An overlay timed past the cut's end is cut off at the end: its `end` is the
cut's length, and its fade out keeps its place (its `fadeOutEnd` is where it
was timed to end). CGL Football's closing bumper layers run until 2.2 s after
the outro starts, as at the open, though the outro is 1.9 s long; Clap-Lite's
and Roam Phone's graphics were laid until 16.1 s over 16 s takes. An overlay
that starts at or after the end is an `after-end` error.

```json
{ "id": "title", "src": "nw6/title.png", "at": "out+0.25", "until": "@end", "fadeIn": 0.35, "fadeOut": 0.45 },
{ "id": "glint", "src": "nw6/glint.png", "at": "title+0.6", "duration": 0.7,
  "motion": [ { "at": "glint", "x": -430, "y": 0 }, { "at": "glint.end", "x": 431, "y": 0 } ] }
```

- `x` and `y` place its top-left corner; `motion` keyframes move it.
- `width` and `height` draw it at that size in output pixels; with only one,
  the other keeps the image's aspect. Default: the image's own size.
- `wave: { "x": …, "y": … }` swings an axis instead (below).
- `opacity` is a constant alpha (0–1) or keyframes, linear between them, two
  at one time making a jump.
- `fadeIn` and `fadeOut` fade its alpha, on top of `opacity`.
- `blink: { "period": 0.7, "on": 0.35 }` shows it for the first `on` seconds
  of each period, counted from its start. Take 10's hazard lamps blink in step
  with the tick this way.

An overlay with a `segment` is drawn into that segment's picture, before its
zoom, so it zooms with the shot. It lies inside the segment, its times are in
the segment's clock (a number is seconds from the segment's start), and it
runs from the segment's start to its end unless `at`, `until` or `duration`
say otherwise.

A wave is `center + amplitude · sin(2π(t − phase) / period)`, or `cos` with
`"shape": "cos"`; `phase` is in seconds. `t` is the overlay's own clock: from
its segment's start for an overlay in a segment, else from its own start. A
wave owns its axis, so the overlay can't also give that axis an `x`/`y` or
motion keys.

Drive-In's grille glow sweeps once across the grille, `x = 52 − 250·cos(2πt)`,
drops out from 1.04 to 1.10 s, and fades over its last 0.3 s. The tag glow is
drawn at 1024×576 into the tag shot from 0.4 s, before the shot's push-in,
drops out from 0.45 to 0.52 s, then sweeps as `x = 360 + 6·sin(2π(t − 0.52))`:

```json
{ "id": "grilleGlow", "src": "nwdi/grille-glow.png", "segment": "grille", "until": 1.28, "y": 65, "fadeOut": 0.3,
  "wave": { "x": { "shape": "cos", "center": 52, "amplitude": -250, "period": 1 } },
  "opacity": [ { "at": 1.04, "value": 1 }, { "at": 1.04, "value": 0 }, { "at": 1.1, "value": 0 }, { "at": 1.1, "value": 1 } ] },
{ "id": "tagGlow", "src": "nwdi/tag-glow.png", "segment": "tag", "at": 0.4, "y": -45, "width": 1024, "height": 576,
  "wave": { "x": { "center": 360, "amplitude": 6, "period": 1, "phase": 0.52 } },
  "opacity": [ { "at": 0.45, "value": 1 }, { "at": 0.45, "value": 0 }, { "at": 0.52, "value": 0 }, { "at": 0.52, "value": 1 } ] }
```

Night Wagon Take 7's scanner sweep over the black open is
`{ "x": { "center": 0, "amplitude": 300, "period": 1.5 } }`.

`picture.fadeIn` and `picture.fadeOut` fade the whole finished picture, after
the overlays, at the start and end of the cut.

## The whole picture and the whole mix

`picture.filters` is a look over the whole finished picture, overlays
included, applied in order before the picture fades. `mix.filters` is
processing over the sum of every sound, applied last. CGL Football's
early-80s tape look and limiter:

```json
"picture": {
  "filters": [
    { "kind": "rescale", "width": 600, "height": 338 },
    { "kind": "chroma-shift", "cb": { "x": 4 }, "cr": { "x": -3 } },
    { "kind": "color", "saturation": 0.84, "contrast": 0.94, "gamma": 1.05 },
    { "kind": "color-balance", "shadows": { "r": 0.03, "b": -0.03 } },
    { "kind": "grain", "strength": 12, "moving": true }
  ]
},
"mix": { "filters": [ { "kind": "limiter", "limit": 0.95 } ] }
```

| Picture filter | Fields | ffmpeg |
|---|---|---|
| `rescale` | `width`, `height`: scaled down to this and back to the output size, which softens it | `scale=600:338,scale=1280:720` |
| `chroma-shift` | `cb` and `cr`: `{ x, y }` pixel shifts of the colour planes | `chromashift=cbh=4:crh=-3` |
| `color` | `saturation`, `contrast`, `gamma` (1 is unchanged), `brightness` (−1–1, 0 is unchanged) | `eq` |
| `color-balance` | `shadows`, `midtones`, `highlights`: `{ r, g, b }` shifts, −1–1 | `colorbalance=rs=0.03:bs=-0.03` |
| `grain` | `strength` (0–100) and `moving` (default true: new every frame) | `noise=alls=12:allf=t` |

A mix filter is any of the sound filters above, or a `limiter` with a `limit`
(0–1 of full scale), ffmpeg's `alimiter=limit=0.95`. RIGG's mix has the same
limiter. Resolved, they are `timeline.filters.picture` and
`timeline.filters.mix`. In a variant, `mix` replaces the base's whole, like
`picture`.

## The sound past the last frame

A cut's sound ends with its picture, at `length`; nothing is heard past it.
An MP4's sound is coded in packets of 1024 samples (21.3 ms at 48 kHz), so a
take's sound track, and every rendered cut's, runs up to one packet past its
last frame: the provider's 16 s takes have 16.021 s of sound, and the
scripts' renders, cut with `-t`, end their sound within a packet of the
length (RIGG's 33.48 s has 33.501 s). That tail is coding padding, not part
of the edit: the scripts never placed sound there, `out-past-media` allows
1 ms of slack against probed lengths rather than the tail, and a renderer
should cut its mix at `length` too, so its sound compares sample for sample
with the originals up to there.

## Variants: `extends`

A cut can be written as changes to another, its base. `extends` names the
base by its file stem, `<name>.cut.json` in the same folder. Bellamy Take 6's
other ending freezes on Rex's smirk instead of her stunned face:

```json
{
  "format": "mdmedia.cut@1",
  "extends": "bellamy-ranch-take6",
  "meta": { "version": "Take 6 (shot by shot, freeze on Rex)" },
  "output": "takes/bellamy-take6-rex.mp4",
  "remove": ["smirk"],
  "segments": [
    { "id": "freeze", "src": "take:bel6-rex-t1", "in": 3.32, "out": 4.2, "end": "sting.end", "fadeOut": 0.5,
      "audio": { "src": "take:bel6-gasp-t1", "in": 1.0, "out": 2.8, "volume": 0.5 } }
  ]
}
```

- `meta` and `media` fields replace the base's, field by field; `output`,
  `picture` and `mix` replace the base's whole; `sources` entries replace the
  base's by source; `check.thresholds` replace the base's field by field.
- In each list, an item with the id of one of the base's items replaces it,
  whole, where it stands; an item with a new id is added at the end. A segment
  can say where it goes with `"after": "<segment id>"`, or `"after": "@start"`
  to go first.
- `remove` drops items by id, from whichever list holds them, performances
  included. A base's performance that names a line the variant removes is an
  `unknown-line` error: replace the performance (same id) or remove it.
  Big Hal Take 6 replaces Take 5's `wheels_joke` with its own one-take
  `["thisone", "comeon"]`.

A base can extend another cut in turn. The loader merges the chain into a full
cut before anything resolves it: `loadCutSource(json, readBase)` takes a
function that returns a base's parsed JSON by name, so it reads no files
itself; `readCutFile(path)` (in `src/cut/align.ts`) reads them from disk, and
`mdmedia cut words` and Studio's viewer use it. `parseCut` alone refuses a
file with `extends`. A variant has its own words file.

## The resolved timeline

`resolveCut(cut, { root?, cutDir?, mediaLength? })` returns either
`{ ok: true, value: timeline }` or `{ ok: false, errors }` with every error it
found. `resolveCutJson` parses untrusted JSON first.

The timeline has:

- `length`, `meta`, the absolute `output` path and the `picture` fades;
- `segments`, `lines`, `music`, `sfx` and `overlays`, each item with absolute
  `start` and `end`, absolute paths (an `asset:` source keeps its ref and
  id), and every default filled in (a segment's
  `hold`, its resolved `audio`, volume and motion keys in seconds);
- `items`: all of them in one list sorted by start, each tagged with its `kind`;
- `filters`: the picture's look and the mix's processing;
- `sources`: provenance by source;
- `at`: every item's start by id;
- `performances`: each performance resolved (above), `[]` when there are none;
- `check`: the cut's check settings, as written.

`gainAt`, `positionAt` and `opacityAt` give a clip's gain or an overlay's
position (waves included) and opacity at any time, for drawing the music line
or previewing; `lineGainAt` gives a line's own sound's gain, `segmentGainAt` a
segment's own audio's (with its mix fades), `bedPartGainAt` a bed part's
crossfade, `overlayShownAt` whether an overlay is drawn, `framesIn` the frames
a span covers, `zoomAt` a segment's scale and focus, and `waveAt` one wave's
value. A resolved segment has `still`, its `mix` fades, and its `zoom` (focus
in pixels, scale keys on the timeline) or null; an overlay its `segment` (or
null), `width`/`height`, `wave` (each axis with its timeline `origin`),
`opacity` keys and `fadeOutEnd`; a line `sung` and `delivery` (or null), and with its own sound its
`in`, `out`, `filters`, fades and `layer`; a clip its `filters`, fades,
`parts`, `segment`, `sync` and `layer`.

Errors have a `code`, a `message`, and usually the item `id` and `field`:

| Code | When |
|---|---|
| `bad-anchor` | A time string isn't a valid anchor |
| `unknown-anchor` | An anchor names no item |
| `cycle` | Times refer to each other in a loop |
| `out-before-in` | An `out` is before its `in` |
| `negative-length` | An item ends before it starts (or a segment has no length) |
| `negative-hold` | A segment's `end` or `duration` is shorter than `out - in` |
| `overlap` | A segment placed with `at` starts before the previous one ends |
| `unknown-length` | Nothing says how long an item runs |
| `before-start` | An item starts before 0 |
| `after-end` | An overlay starts at or after the cut's end |
| `negative-in` | An `in` is below 0, as written or worked out from a sync point |
| `fade-too-long` | Fades are longer than the item, or a bed's crossfade is longer than a part it joins |
| `keyframes-unordered` | Keyframes go back in time |
| `out-past-media` | An `out` is past the probed media length |
| `length-mismatch` | `meta.length` differs from the segments' total |
| `outside-segment` | A zoom key, an overlay in a segment, a layer, or a clip labelling a segment's sound starts outside that segment |
| `outside-clip` | A line heard in a clip starts outside it |
| `unknown-clip` | A line's `clip` names no music or sfx clip |
| `bad-value` | A number is out of its range (a scale below 1, an opacity over 1, a filter's bits), or an `asset:` source has no valid id |
| `unknown-item` | An extension removes, or places a segment after, an id its base doesn't have, or its base can't be read |
| `extends-cycle` | Cuts extend each other in a loop |
| `unknown-line` | A performance names a line the cut doesn't have |
| `shared-line` | A line is in two performances, or twice in one |
| `duplicate-id`, `bad-id`, `unknown-segment`, `loop-needs-length`, `conflicting-fields`, `no-segments`, `bad-shape` | As named |
