# Presenter generation proof

## Question

Can the supplied desk video serve as a reference for a new scripted presenter
performance, followed by a continuous second generated passage?

This experiment is isolated from Studio documents and jobs. The source recording
and existing timeline remain unchanged. Reproducer: `scripts/presenter-proof.ts`.
Local media and interaction checkpoints: `/private/tmp/mdmedia-presenter-proof`.

## Provider contract checked on 2026-10-05

[Google Omni documentation](https://ai.google.dev/gemini-api/docs/omni):

- Video likeness references accept clips up to three seconds. Their audio is
  ignored; this path does not reproduce the source speaker's voice.
- Bind the video explicitly as `<VIDEO_REF_0>` and request a new performance.
- New spoken dialogue cannot be appended directly to an uploaded talking video.
- A generated speaking video can be extended with more dialogue using its
  `previous_interaction_id`.
- Extensions can change the tail of the previous clip to make the join continuous.
  Timeline assembly must account for this rather than simply appending two full
  returned videos or adding an automatic fade.

## Experiment

1. Use the first three seconds of the normalized `IMG_0017.MOV`, without audio,
   as a visual reference. Generate a ten-second presenter performance:

   > I gave my terminal a Hollywood budget. Images, video, music, sound effects.
   > The terminal has an agent now.

2. Extend that generated interaction by ten seconds:

   > Today, we are using M D media to make the whole thing. If this works, my
   > keyboard gets executive producer credit.

3. Inspect frames, media duration and tracks, and an automated audiovisual review.
   Human playback remains necessary to judge acceptable likeness and performance.

The script uses the configured Gemini credential without printing it, saves each
successful turn before continuing, and refuses to rerun an already saved turn.
It makes no changes to the application or its production generation behavior.

## Implications for Studio

Presenter is a visual role, not a synonym for an upload requirement. Production
method must be separate: reference-based generation, continuation of a generated
performance, or an explicitly chosen recording. New dialogue must be sent to the
video provider, not stored only as an inspector note.

This experiment does not establish exact voice matching, a seamless join from
the original recording, accurate generated software demonstrations, or a complete
75-second video. Those must not be implied by Build video.

## Observed result

Both live generation requests succeeded with `gemini-omni-1.1-flash`:

| Turn | Output duration | Generation time |
| --- | --- | --- |
| New reference-based presenter | 10.006s | 42.3s |
| Continuation (includes first turn) | 20.011s | 75.6s |

The combined output is 1280×720 H.264 at 24fps with stereo AAC audio. FFmpeg
decoded the full file without errors. No manual crossfade or stitching was used.

Automated audiovisual review transcribed both intended passages, with “M D media”
rendered in its transcript as “MD media.” It reported synchronized lip movements,
consistent generated voice, and minor facial rendering artifacts. These are model
judgments, not a substitute for the user's assessment. Sampled frames retain the
reference's recognizable face, clothing, desk and room, but show framing drift
near the extension boundary; do not describe the result as perfectly seamless.

Conclusion: the provider can produce a new scripted presenter performance from
this visual reference and extend its dialogue. Exact source-voice matching and
seamless continuation from the original recording have not been demonstrated.
Studio's current blanket “presenter requires recording” behavior is too restrictive.

Playback: `/private/tmp/mdmedia-presenter-proof/02-continuous-presenter.mp4`.
Prompts, interaction checkpoints and automated review are saved beside the video.
