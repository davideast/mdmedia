# Cut files

A cut file is an edit written as data: one JSON file that says which shots
play, in what order, with which lines, music, sound effects and overlays. It
replaces the hand-written ffmpeg script per clip. A renderer compiles it into
the video; an editor view reads it to draw a player and a timeline.

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
  "picture": { "fadeOut": 0.5 }
}
```

Only `format`, `meta`, `media` and `segments` are required. `meta.length` is
optional; when it is set, the resolver checks that the segments add up to it.

Every item has an `id`: letters, digits and underscores, unique across the
whole file. Most items also take a `label` for the timeline.

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
| `audio/tts/b2.wav` | A path under the root |

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

How each item's start and end are found:

- **Segments** run one after another. A segment starts where the previous one
  ends (the first at 0), unless it has an `at`. Its end is its `end` anchor if
  it has one, else its start plus its length.
- **Lines, music, sound effects and overlays** start at their `at`. They run
  for their natural length (`duration`; for audio, else `out - in`, else the
  probed media length), cut off at `until` if that comes first. With only an
  `until`, they end there.
- **A line from a segment** starts and ends with its segment, unless its `at`
  or `until` says otherwise.
- **Keyframes** (volume, motion, opacity, zoom) are placed by the same
  anchors. Nothing can anchor to a keyframe.
- **Inside a segment** (its zoom keys, and an overlay drawn into it), a number
  is seconds from the segment's start, so it moves with the segment; a string
  is an anchor as anywhere else. `0.4` and `"tag+0.4"` are the same time there.

Every item has two points, `id.start` and `id.end`. The resolver computes each
point from the points it refers to. A point that refers back to itself, by any
path, is a `cycle` error that names the path, for example
`x.start → y.start → x.end → x.start`.

Times are rounded to the microsecond. They are not snapped to frames.

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
  same `in`/`out`. An object changes the `src`, `in`, `out`, `volume` or fades;
  `false` silences it. Segment audio plays once from the segment's start, never
  holds or loops, and is cut at the segment's end.

Buddy's shots are a dashboard picture over a quiet room hum from another take:

```json
{ "id": "b2", "src": "take:nw6-buddy-t2", "in": 1.0, "out": 2.55,
  "audio": { "src": "take:nw7-dash-t1", "in": 0, "volume": 0.7 } }
```

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
take), or is words heard in a segment's own audio (Rick on camera). A segment
line adds no sound; it labels the timeline.

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

The format only describes them; nothing renders a cut yet.

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

## Music, stings and sound effects

`music` and `sfx` hold the same kind of clip: a `src` (or a `synth`), an `in`
offset, an `at`, and an `until` or `duration`. `volume` is a number or a list
of keyframes, linear between keys and held before the first and after the last.
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

A `synth` is a generated sound. The one kind so far is Take 10's hazard relay:

```json
{ "id": "tick", "at": "haz", "until": "haz.end", "fadeOut": 0.15,
  "synth": { "kind": "tick", "period": 0.35, "tones": [2300, 1700], "click": 0.03, "decay": 180, "gain": 0.35 } }
```

Every `period` seconds it plays the next tone from `tones` for `click` seconds,
as `gain · sin(2π·f·t) · e^(−decay·u)`, where `t` is time from the clip's start
and `u` is time since the tick began.

## Overlays

A PNG over the picture, from `at` to `until` (or for `duration`), drawn in
list order:

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

- `meta` and `media` fields replace the base's, field by field; `output` and
  `picture` replace the base's whole.
- In each list, an item with the id of one of the base's items replaces it,
  whole, where it stands; an item with a new id is added at the end. A segment
  can say where it goes with `"after": "<segment id>"`, or `"after": "@start"`
  to go first.
- `remove` drops items by id, from whichever list holds them.

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
  `start` and `end`, absolute paths, and every default filled in (a segment's
  `hold`, its resolved `audio`, volume and motion keys in seconds);
- `items`: all of them in one list sorted by start, each tagged with its `kind`;
- `at`: every item's start by id.

`gainAt`, `positionAt` and `opacityAt` give a clip's gain or an overlay's
position (waves included) and opacity at any time, for drawing the music line
or previewing; `zoomAt` gives a segment's scale and focus, and `waveAt` one
wave's value. A resolved segment has its `zoom` (focus in pixels, scale keys on
the timeline) or null; an overlay its `segment` (or null), `width`/`height`,
`wave` (each axis with its timeline `origin`) and `opacity` keys; a line with
its own sound its `in`, `out` and `filters`; a clip its `filters`.

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
| `fade-too-long` | Fades are longer than the item |
| `keyframes-unordered` | Keyframes go back in time |
| `out-past-media` | An `out` is past the probed media length |
| `length-mismatch` | `meta.length` differs from the segments' total |
| `outside-segment` | A zoom key or an overlay in a segment is outside that segment |
| `bad-value` | A number is out of its range (a scale below 1, an opacity over 1, a filter's bits) |
| `unknown-item` | An extension removes, or places a segment after, an id its base doesn't have, or its base can't be read |
| `extends-cycle` | Cuts extend each other in a loop |
| `duplicate-id`, `bad-id`, `unknown-segment`, `loop-needs-length`, `conflicting-fields`, `no-segments`, `bad-shape` | As named |
