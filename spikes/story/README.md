# Story spike (throwaway)

One script that renders a story file to an MP3 so we can listen before
designing more. Nothing here is part of the package; `LEARNINGS.md` is the only
thing meant to outlive this branch.

```bash
export GEMINI_API_KEY=...            # the script reads only this
bun spikes/story/render.ts spikes/story/lighthouse.md --mode line
bun spikes/story/render.ts spikes/story/lighthouse.md --mode run
bun spikes/story/render.ts spikes/story/lighthouse.md --fake   # tones, no key
```

Output lands in `spikes/story/out/lighthouse/<mode>/`: the MP3, `master.wav`,
one WAV per API call under `calls/`, and `report.json` (calls, characters,
wall time, audio length, quiet edges per call, usage if the API returned it).

- `--mode line`: one call per line, the shape the current design assumes.
- `--mode run`: consecutive lines with at most two speakers, with no pause or
  scene break between them, go in one multi-speaker call (the API takes
  exactly two speakers).
- `--gap 0ms` / `--gap 250ms`: try other fixed gaps (default 400 ms).
- `--max-run 1500`: the most characters one run-mode call may carry.
- `--model <id>`: another TTS model.

Inputs: `lighthouse.md` (written for the spike), `pride-and-prejudice-34.md`
and `earnest-act-1.md` (public domain, from Project Gutenberg, adapted to the
notation by hand).

## What to listen for

1. **Delivery**: do `(whispering)`, `(cutting him off, sharp)` and
   `(barely audible)` audibly change the line?
2. **Consistency**: in `line` mode, does Mara sound like one person across
   her seven separate calls?
3. **Line vs run**: does the multi-speaker call sound more like a scene?
   Does it keep the delivery cues and the right voice per speaker?
4. **Timing**: is a fixed 400 ms gap natural or mechanical? Does the
   interruption (`She says—` then a `0ms` pause) land?
5. **Edges**: `report.json` lists the quiet lead and tail of each call. If
   they vary a lot, the gaps we hear are not the gaps we wrote.
6. **Cost and time**: calls, characters and wall time per mode.
