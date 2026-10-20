# Rendering a cut

`mdmedia cut render` turns a [cut file](cut-format.md) into an MP4 with
ffmpeg: every segment, line, music and sound-effect clip, overlay, filter and
fade the cut resolves to.

```sh
mdmedia cut render docs/cuts/big-hal-take5.cut.json
mdmedia cut render docs/cuts/rigg-take5.cut.json --from lock-0.5 --to c0019.end --preview
mdmedia cut render docs/cuts/breeze-take4.cut.json --out /tmp/breeze.mp4 --print
```

| Option | Means |
|---|---|
| `--out <path>` | The file to write. Default: `<media root>/renders/<name>.mp4` |
| `--from <time>`, `--to <time>` | Render only this stretch. A time is seconds (`12.5`), frames (`f300`) or an anchor (`pat`, `pat.end+0.5`, `@end-2`), as in the cut |
| `--preview` | A fast render at half size (x264 `veryfast`, CRF 26) |
| `--root <dir>` | The media root (default `MDMEDIA_CUT_MEDIA_ROOT`, else the cut's `media.root`) |
| `--crf <n>`, `--preset <name>` | x264 quality and speed (default CRF 16, `slow`) |
| `--timing script` | Join segments as the CRT TV scripts did, for comparing with their renders (below) |
| `--print` | Print the ffmpeg command and stop |
| `--force` | Overwrite an existing file outside the renders folder |

Without `--out`, a range or a preview names the file after itself:
`renders/rigg-take5.10.43-14.68.preview.mp4`. The command never writes over one
of the cut's own sources, and won't overwrite any other existing file outside
`<media root>/renders/` without `--force`, so a render can't replace the
finished take named by the cut's `output`. ffmpeg is `FFMPEG_PATH`, else
`ffmpeg-static`, else `ffmpeg` on the `PATH`, as for `mdmedia cut words`.

Before ffmpeg starts, the command reads every file the cut plays: a missing
one is an error, MP4 and WAV lengths are probed (so `out-past-media` and the
lengths of clips without an `out` come from the files), and a take with no
sound track plays as silence, with a note.

## Output

The CRT TV edit scripts' settings: the cut's `width` × `height` at its `fps`,
H.264 (`libx264 -preset slow -crf 16`, `yuv420p`), AAC at 192 kb/s and
48 kHz, `+faststart` (Football's script alone used CRF 17; `--crf 17` matches
it). There is no loudness normalisation; nothing in the
scripts had any, and a cut's levels are its own. The sound ends at the cut's
`length` (see [the sound past the last frame](cut-format.md#the-sound-past-the-last-frame)).
The picture runs to the end of the frame that starts before `length`, as the
scripts' renders did: a 27.31 s cut is 656 frames, 27.333 s.

## Plan, then run

Rendering is two steps:

1. **`planRender(timeline, options)`** (`src/cut/render/plan.ts`, exported
   from `mdmedia/cut`) turns a resolved timeline into a `RenderPlan`: the
   ffmpeg inputs, one filter graph and the output settings. It is pure: it
   reads no files and runs nothing, so it is tested without ffmpeg
   (`plan.test.ts`). `renderArgs(plan)` is the ffmpeg command line.
2. **`runRender(plan)`** (`src/cut/render/run.ts`) runs ffmpeg on it, with
   progress. `loadCutForRender(path)` reads a cut (and any base it extends),
   probes its media and resolves it; `planLoadedRender` plans it with what
   the probe found.

`RenderOptions` are the output path, `from` and `to`, `preview`, `crf`,
`preset`, `hasAudio` (which takes and files have a sound track),
`assetPath` (the local file for an `asset:` source) and `timing` (below).

## The graph

It is built the way the CRT TV scripts built theirs, so a cut renders what
its script rendered:

| In the cut | In the graph |
|---|---|
| A shot | `trim` from `in` to `out` (crop first), `fps`, scaled to the output size, then `tpad` for its hold |
| A `pingpong` loop | The stretch split, every other copy `reverse`d, joined and trimmed to the segment's length |
| A still | The image looped (`-loop 1`) and trimmed to the segment's length |
| `color:` | ffmpeg's `color` source |
| Overlays in a segment | Drawn into the segment's picture, in its clock, before its zoom |
| A zoom | `scale` each frame by the keys' scale, then `crop` back to the picture with the focus held in place |
| Segment fades | `fade` on the segment's picture |
| A segment's sound | Its audio (`atrim` from its in-point, at its volume and fades), padded to the segment's length, with each `layer` mixed in, then the `mix` fades |
| A synth | `sine` for a tone at 1/8 of full scale (RIGG's beep), else `aevalsrc` with the tone or tick formula, mono then stereo like every other sound |
| A line with its own sound, music, a sound effect | Its own chain: `atrim` from its in-point for its length on the timeline, its filters, its volume (keys as a per-frame expression, every 256 samples), its fades (`afade`, anchored where the cut says), then `adelay` to its start, to the sample |
| A bed | Its parts `acrossfade`d (linear), cut to the clip's span, then as above |
| Sound heard in a segment or a clip | Nothing: it adds no sound |
| Overlays over the picture | `overlay` in list order, each image sized (`scale`), faded (`fade` on its alpha), at its opacity (`colorchannelmixer`, or `geq` for keys, or the `enable` expression for keys that only jump between 0 and 1), at its position (motion keys or a wave as an expression), drawn on the frames its span covers, both ends included, in its blink |
| `picture.filters` | `scale` down and back (bilinear, then bicubic), `chromashift`, `eq`, `colorbalance`, `noise` |
| `picture` fades | `fade` on the finished picture |
| Every sound together | `amix` unnormalised (a plain sum), then `mix.filters` (`alimiter` for a limiter) |
| Sound filters | `highpass`, `lowpass`, `acrusher`, `aecho` (delay in ms) |

### Timing: the cut's frames, or the scripts'

A cut's times are not on the frame grid. The renderer puts frame k (at k / fps)
in the segment playing at that time: a segment from `start` to `end` gets the
frames from ⌈start · fps⌉ up to ⌈end · fps⌉, its last frame held if its source
runs short and its frames past its end dropped. Each of those frames shows the
source frame nearest to `in + (k / fps − start)`, the moment the segment's
sound is playing then, so picture and sound keep time to within half a frame.
The sound starts on its own sample. The pictures are joined with `concat`, and
the sounds separately, so both stay on the cut's times however many segments
come before. An overlay is drawn on the frames its span covers
(`framesIn`), both ends included.


The scripts joined each segment's picture and sound together with
`concat=v=1:a=1`, so each segment lasted as long as the longer of the two: its
sound exactly, its picture in whole frames. Whenever `trim` left the picture a
little longer, the next segment started that much later, picture and sound
together, while the music, the effects and the laid-in lines (placed with
`adelay` at the times the script printed) and the overlays did not move. By
the end of Breeze Take 4 its shots were 4–5 frames (about 0.2 s) later than
its own timeline; in Big Hal, RIGG and Night Wagon up to 2 frames. Football's
script joined the picture alone, so its shots drifted by its own rounding,
here a frame early.

`--timing script` (`timing: 'script'`) joins segments the scripts' way, for
comparing with their renders. In it the ports render what their scripts
rendered, frame for frame (below).

## Checked against the original renders

Each port in [cuts/](cuts) with a finished take was rendered and compared
with the take its script (or `compose.mjs`) made: the video and sound track
lengths, PSNR and SSIM on every frame, and on the frames either side of every
segment cut and every overlay's first and last frame; the correlation of the
two sounds' loudness (RMS in 50 ms windows, in dB) and the sound's residual
(the difference's energy against the original's); integrated loudness (EBU
R128); and the encoded packets themselves. ∞ is identical. Rendered on
2026-10-19 with ffmpeg-static 7.0.2, the scripts' own ffmpeg.

A residual below about −25 dB is AAC coding noise, not a change in the mix:
change anything in a mix and the encoder codes the whole file differently.
Re-running the RIGG script with nothing but its tension cue's −59 dB change
gives −25 to −30 dB.

### In the scripts' timing: the graph

| Cut | Video s (orig / render) | Δ frames | PSNR dB mean / min | SSIM min | Cut & overlay frames: PSNR min | Loudness corr. | Residual dB | LUFS orig / render | Packets: video / sound |
|---|---|---|---|---|---|---|---|---|---|
| big-hal-take5 | 27.333 / 27.333 | 0 | ∞ / ∞ | 1.0000 | ∞ (38 frames) | 1.0000 | −∞ | −22.6 / −22.6 | same / same |
| big-hal-take6 | 25.917 / 25.917 | 0 | ∞ / ∞ | 1.0000 | ∞ (36 frames) | 1.0000 | −∞ | −22.2 / −22.2 | same / same |
| big-hal-take7 | 36.292 / 36.292 | 0 | ∞ / ∞ | 1.0000 | ∞ (40 frames) | 1.0000 | −47.7 | −21.8 / −21.8 | same / differ |
| rigg-take5 | 33.500 / 33.500 | 0 | ∞ / ∞ | 1.0000 | ∞ (53 frames) | 1.0000 | −29.8 | −21.5 / −21.5 | same / differ |
| regulars-take3 | 21.542 / 21.542 | 0 | ∞ / ∞ | 1.0000 | ∞ (7 frames) | 0.9994 | −57.5 | −21.6 / −21.6 | same / differ |
| breeze-take4 | 30.667 / 30.667 | 0 | 88.8 / 25.6 | 0.9602 | 28.6 (42 frames) | 0.9998 | −25.3 | −14.1 / −14.1 | differ / differ |
| football-take1 | 42.667 / 42.667 | 0 | 32.5 / 12.4 | 0.5031 | 12.4 (44 frames) | 0.9979 | −12.3 | −18.6 / −18.7 | differ / differ |
| palm-court-take2 | 18.000 / 18.000 | 0 | ∞ / ∞ | 1.0000 | ∞ (6 frames) | 1.0000 | −35.9 | −24.8 / −24.8 | same / differ |
| clap-lite-take2 | 16.000 / 16.000 | 0 | ∞ / ∞ | 1.0000 | ∞ (13 frames) | 1.0000 | −36.2 | −18.8 / −18.8 | same / differ |
| roam-phone-take2 | 16.000 / 16.000 | 0 | ∞ / ∞ | 1.0000 | ∞ (12 frames) | 1.0000 | −35.0 | −21.5 / −21.5 | same / differ |
| bellamy-ranch-take6 | 25.500 / 25.500 | 0 | ∞ / ∞ | 1.0000 | ∞ (21 frames) | 1.0000 | −∞ | −24.7 / −24.7 | same / same |
| bellamy-ranch-take6-rex | 25.500 / 25.500 | 0 | ∞ / ∞ | 1.0000 | ∞ (19 frames) | 1.0000 | −∞ | −24.7 / −24.7 | same / same |
| night-wagon-take9 | 26.292 / 26.292 | 0 | 90.3 / 14.1 | 0.6770 | 44.5 (35 frames) | 0.9731 | −10.6 | −16.4 / −16.4 | differ / differ |
| night-wagon-take10 | 31.125 / 31.125 | 0 | 84.7 / 14.1 | 0.6770 | 35.5 (42 frames) | 0.9965 | −11.8 | −16.7 / −16.8 | differ / differ |
| night-wagon-drive-in | 38.667 / 38.667 | 0 | 84.9 / 13.9 | 0.6750 | 14.3 (54 frames) | 0.9445 | −9.4 | −18.2 / −18.2 | differ / differ |

Big Hal 5 and 6 and both Bellamy 6 endings encode to the same packets as the
originals. Every other difference is one the cut makes on purpose, or a
change in how a script happened to compute something:

- **Big Hal 7**: the take's sound up to "So" lifted 2.5 dB is now the wc
  shot's own audio to 3.6 s at 1.3335, and "So come on down…" a line carrying
  its own stretch of the take, at 1. The script switched gain at the first
  decoded audio frame (about 21 ms) at or after 3.6 s; the render does it on
  the sample.
- **RIGG 5**: the tension cue's rise is volume keys (0.18, a step to 0.22 on the
  first montage cut, then a ramp to 0.47 at the turn). The script wrote the
  ramp's slope rounded (0.0185/s, so 0.46975 at the turn) and stepped its gain
  once per decoded MP3 frame; the render uses the exact slope, stepped every
  256 samples. The cue alone differs by −59 dB.
- **Regulars 3**: the script faded the whole joined sound over its last 0.7 s
  at an absolute time; the cut makes that the sit shot's own fade, timed to the
  shot's end. The two differ only in the last 0.5 s, where the sound is down
  at −46 dB, by about 1 dB.
- **Breeze 4**: the cut draws NEW!, the BREEZE label, the logo and the tagline
  into their shots (the roll and the packshot), in each shot's clock. The
  script laid them over the joined picture at the times it printed, which by
  then were 2 and 4 frames ahead of those shots, so in the original they came
  2 and 4 frames early against the picture. The jingle's ducks jump at their
  keys in the render. The script rounded those times to 10 ms and applied each
  jump at the next decoded MP3 frame (about 26 ms).
- **Palm Court 2, Clap-Lite 2, Roam Phone 2**: `compose.mjs` copied the take's
  AAC sound untouched (`-c:a copy`); the renderer mixes every cut's sound and
  encodes it, so this is a second AAC generation (−35 to −36 dB, loudness
  identical). Palm Court's copied track runs 5 ms longer.
- **Football 1**: its script joined the picture alone and put every sound on
  the timeline, so neither timing models it, and it encoded at CRF 17; see
  below.
- **Night Wagon 9, 10 and Drive-In**: each script's outro fade
  (`fade=t=out:st=2.9`) sat before its `setpts`, so it ran in the source's
  clock and faded the road out 1.4 s early. The cut fades the last 0.7 s, as
  written. Drive-In's two push-ins differ by sub-pixel scaling (≥ 38 dB): that
  script rounded the zoomed width to even and took the height from the aspect,
  and the renderer scales width and height by the same factor, as RIGG's script
  did.

Barnstormers, Clearline and Meridian are single provider takes with no edit
(their "original" is the provider's file), so their renders are a re-encode
of it: picture ≥ 45 dB, loudness identical.

### In the cut's timing: `renders/<name>.mp4`

| Cut | Video s (orig / render) | Δ frames | PSNR dB mean / min | SSIM min | Cut & overlay frames: PSNR min | Loudness corr. | Residual dB | LUFS orig / render | Packets: video / sound |
|---|---|---|---|---|---|---|---|---|---|
| big-hal-take5 | 27.333 / 27.333 | 0 | 65.1 / 12.6 | 0.6351 | 12.6 (38 frames) | 0.9187 | 0.5 | −22.6 / −22.6 | differ / differ |
| big-hal-take6 | 25.917 / 25.917 | 0 | 66.7 / 12.4 | 0.6319 | 12.4 (36 frames) | 0.9267 | 0.7 | −22.2 / −22.3 | differ / differ |
| big-hal-take7 | 36.292 / 36.292 | 0 | 46.9 / 12.7 | 0.6282 | 12.7 (40 frames) | 0.9294 | 2.2 | −21.8 / −21.8 | differ / differ |
| rigg-take5 | 33.500 / 33.500 | 0 | 46.3 / 13.1 | 0.6446 | 13.1 (53 frames) | 0.9624 | −6.3 | −21.5 / −21.5 | differ / differ |
| regulars-take3 | 21.542 / 21.542 | 0 | 81.6 / 23.9 | 0.8542 | 27.0 (7 frames) | 0.9787 | −5.7 | −21.6 / −21.7 | differ / differ |
| breeze-take4 | 30.667 / 30.667 | 0 | 31.2 / 10.2 | 0.3969 | 10.2 (42 frames) | 0.9797 | −20.4 | −14.1 / −14.1 | differ / differ |
| football-take1 | 42.667 / 42.667 | 0 | 37.0 / 12.9 | 0.5775 | 12.9 (44 frames) | 0.9988 | −29.2 | −18.6 / −18.6 | differ / differ |
| palm-court-take2 | 18.000 / 18.000 | 0 | ∞ / ∞ | 1.0000 | ∞ (6 frames) | 1.0000 | −35.9 | −24.8 / −24.8 | same / differ |
| clap-lite-take2 | 16.000 / 16.000 | 0 | ∞ / ∞ | 1.0000 | ∞ (13 frames) | 1.0000 | −36.2 | −18.8 / −18.8 | same / differ |
| roam-phone-take2 | 16.000 / 16.000 | 0 | ∞ / ∞ | 1.0000 | ∞ (12 frames) | 1.0000 | −35.0 | −21.5 / −21.5 | same / differ |
| bellamy-ranch-take6 | 25.500 / 25.500 | 0 | 57.2 / 9.8 | 0.7078 | 12.2 (21 frames) | 0.9616 | −3.3 | −24.7 / −24.7 | differ / differ |
| night-wagon-take9 | 26.292 / 26.333 | 1 | 54.2 / 14.2 | 0.6531 | 15.7 (36 frames) | 0.9216 | −4.8 | −16.4 / −16.4 | differ / differ |
| night-wagon-drive-in | 38.667 / 38.667 | 0 | 39.3 / 12.7 | 0.5688 | 12.7 (54 frames) | 0.9098 | −6.4 | −18.2 / −18.2 | differ / differ |

The differences from the table above are the scripts' drift, undone: each
shot now starts on the cut's frame, and its sound on the cut's sample. Where
the original had each shot, against the render (the render's frame a third of
the way into the shot matched among the original's, and the shot's sound
cross-correlated):

| Cut | Picture, latest shots | Shots' own sound |
|---|---|---|
| Big Hal 5 / 6 | +1 to +2 frames from the pat on | +25 ms from the second shot, +58 ms from the wheels |
| Big Hal 7 | −1 to +2 frames | +17 to +63 ms |
| RIGG 5 | +1 to +2 frames from the shove on | +20 ms (shove, line 1) to +70 and +103 ms (turn, her) |
| Regulars 3 | 0 to +1 frame | +41 ms (Walt's lines) |
| Breeze 4 | +1 to +5 frames from the flat tyre on | the mix is the jingle and announcer, placed by the timeline in both: 0 ms |
| Football 1 | −1 frame (the pass, the catch, the tackle) | every sound placed by the timeline in both: 0 ms |
| Night Wagon 9, Drive-In, Bellamy 6 | +1 to +2 frames | +8 to +100 ms |
| Palm Court, Clap-Lite, Roam Phone | 0 | 0 |

Integrated loudness matches to 0.1 LU everywhere, and every picture runs to
the same frame as its original, except Night Wagon 9: the cut's 26.3 s ends
partway through frame 631, which the render keeps, as every other render does;
the original's last frame came out of its drifted, off-grid timeline after
26.3 s, and `-t` dropped it.
Football's picture also differs by its grain: `noise` draws a different pattern
in the two graphs. With the grain left out of both, its frames match at
≥ 45 dB except the one-frame shifts, and the stadium shot by a frame's phase.
Football's crowd ducks jump at their keys rather than per decoded frame, as in
RIGG.

## Not supported

- `asset:` sources from the command line: the plan takes an `assetPath`
  function, but the CLI has no way to fetch Studio assets yet, so it stops
  with an error naming the asset.
- A zoom's focus is held in whole pixels by `crop`, so a slow push-in can step
  by a pixel, as the scripts' did.
- `--preview` halves the finished picture, so a heavy picture look (Football's
  tape look) still runs at full size: 38 s for Football's 42.6 s, against
  about 75 s at full quality. A range renders only the segments it touches.
