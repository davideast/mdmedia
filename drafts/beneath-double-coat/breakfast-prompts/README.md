# Breakfast at Alpenrose — production packet

This is the offline compilation of the approved 90-second screenplay. No media generation or project import has been submitted.

## Files

- `../breakfast-exposition-90s.md`: human-readable screenplay, unchanged.
- `../breakfast-production-plan.json`: structured cast, scene geography, timed actions, dialogue ownership, cut/continuation dependencies, and symbolic reference assets.
- `prompts.md`: twelve compiled prompts, in playback order.
- `requests.json`: machine-readable generation requests and the editorial audio contract. This is a production plan, not a payload accepted directly by the current Studio API.

Recompile from the repository root:

```sh
bun scripts/compile-production-plan.ts \
  drafts/beneath-double-coat/breakfast-production-plan.json \
  drafts/beneath-double-coat/breakfast-prompts
```

The compiler checks the screenplay hash and refuses to compile a stale adaptation after screenplay edits. Reconcile intentional changes in the structured plan before updating that hash.

## Prompt audit

- 90 seconds, 12 segments, six camera shots: `01–03`, `04`, `05–07`, `08`, `09–10`, `11–12`.
- Six actual continuation requests; five intentional editorial cuts after the opening.
- The exterior-to-interior move remains one 24-second camera shot.
- Eleven dialogue cues, with one explicit owner each. Otto has no spoken lines.
- Offscreen Heidi in segment 02 is distinct from visible Otto, even though she addresses him by name.
- Segment 09 has two consecutive speakers with a silent pause, rather than a combined dialogue paragraph.
- Heidi’s interruption is one 4.5-second external cue, `d10`, from 74.5–79s. Segment 10 uses its first 0.5s offscreen; segment 11 uses its remaining 4s on camera. The full line is stored once in the audio contract and omitted from native video dialogue prompts.
- Timings in the source plan are absolute. Timings within each generated prompt are local to that new segment.

## Execution handoff

Character and location references are intentionally unresolved asset keys, not fabricated file paths. Prepare the five individual character references and consistent exterior/interior references before submission. Resolve generated-frame references only from accepted predecessor footage. For a continuation, pass the real previous provider interaction ID and preserve its chain; the word “continue” in a text prompt is not sufficient.

The current provider accepts image references and continuation IDs but exposes no audio-input or voice-reference option. Native dialogue has explicit voice direction but cannot be represented as technically voice-locked. The external `d10` cue requires one voice recording, synchronization of visible Heidi in segment 11, and timeline placement across the cut. That postproduction task is explicit and is not implemented by the current `studio-build.ts` runner. Do not flatten this packet into its legacy dialogue string and claim equivalent execution.

The agent should resolve those production capabilities, bind references, and verify speaker ownership on the generated takes. These are production tasks, not a checklist for the viewer.
