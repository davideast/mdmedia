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
  "media": { "root": "/tmp/…/scratchpad/crt", "takes": "takes/{name}.mp4" },
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
so moving the media out of the scratchpad means changing one value.

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
- **Keyframes** (volume, motion) are placed by the same anchors. Nothing
  can anchor to a keyframe.

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

## Lines

A line is either its own audio file (TTS), or words heard in a segment's own
audio (Rick on camera). A segment line adds no sound; it labels the timeline.

```json
{ "id": "getaway", "speaker": "Rick", "text": "They're getting away, Buddy.", "segment": "r1" },
{ "id": "bridge", "speaker": "Buddy", "text": "The bridge ahead is out, Rick.", "src": "audio/tts/b2.wav",
  "at": "b2+0.05", "until": "b2.end", "duration": 1.8576 }
```

`duration` is the file's length. A probe passed to the resolver overrides it.
`until: "b2.end"` cuts the line off with Buddy's shot, as the script did.
A segment line can run past its segment with `until`: "TURBO... BOOST!" is
`"segment": "yell", "until": "press.end"`.

`words` (optional) are `{ text, start, end }` in the audio's own clock: the
file's time for TTS, the source take's time for a segment line. The resolver
maps them onto the timeline and drops words outside the line.

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
- `fadeIn` and `fadeOut` fade its alpha.
- `blink: { "period": 0.7, "on": 0.35 }` shows it for the first `on` seconds
  of each period, counted from its start. Take 10's hazard lamps blink in step
  with the tick this way.

`picture.fadeIn` and `picture.fadeOut` fade the whole finished picture, after
the overlays, at the start and end of the cut.

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
position and opacity at any time, for drawing the music line or previewing.

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
| `duplicate-id`, `bad-id`, `unknown-segment`, `loop-needs-length`, `conflicting-fields`, `no-segments`, `bad-shape` | As named |
