# Studio media hierarchy and image-first UI proposal

Status: proposal only, 2026-10-09. No application code, dependencies, provider credentials, service configuration, or deployed build changed. This note records investigation and a proposed first slice; it does not authorize implementation or resolve every future product decision.

This is the historical investigation snapshot. The subsequently authorized
Gemini-only implementation and its verification are documented in
[Studio media API](../docs/studio-media-api.md).

## Recommendation

Keep Variant A's shared navigation and one active document. Change **Create narration** to **Create**, with a small choice of supported media. Start image generation with one prompt box, one **Generate image** button, and one result. Put optional customization in an **Image options** panel that is closed by default. Preserve the narration screen's interaction pattern, with medium-specific controls behind it.

The user's clarification is central: direct prompt → result is the default. An optional adaptation toggle should turn notes or Markdown into visual direction, analogous to narration's adaptation for the ear. The image engine already supports the direct path; the adaptation path is proposed new behavior.

## What exists, and what is a dependency

| Source inspected | What it actually provides |
| --- | --- |
| Current Studio branch `feature/studio-library-navigation`, commit `44f4c69` | Variant A navigation, narration composer/jobs/library/storage, and the core's inline Gemini image CLI command. No reusable image module in the installed Studio engine package. |
| Image-provider PR [#38](https://github.com/davideast/mdmedia/pull/38), commit `3a877e3`, still open when inspected | Exported `mdmedia/image` module; Gemini, OpenAI, Retro Diffusion, and PixelLab adapters; capability validation; one reference; one still image; CLI workflow and metadata. No Studio image UI, application jobs, or note-to-image adaptation. |
| Separate remote `feature/studio-video-generation`, commit `8a6848c` | Experimental Create menu, Projects navigation, video brief/script/scene work, asset attachments, generation jobs, and video Library/Activity integration. It is not the deployed navigation branch and should be reconciled before implementation, not copied wholesale into this first image slice. |

The Studio currently installs `mdmedia` from a local tarball, so merging engine source alone does not update its runtime dependency. Refresh and verify that package when image integration begins. Source: [Studio package dependency](../studio/package.json#L54).

## Content hierarchy: one authored item, executions, and output files

Proposed vocabulary, rather than an approved repository glossary:

| Concept | Meaning | Where the user encounters it |
| --- | --- | --- |
| Creation | One authored item of a chosen kind: Narration, Image, Video, or Music. Holds title, source, references, and generation history. | One Library card and one active viewer. UI can call it its actual kind, such as “Image,” rather than introducing “Creation” everywhere. |
| Draft | A creation that has not yet submitted its first generation. Source and settings are editable and auto-saved. | Drafts, with a media-type filter. |
| Generation | One execution with an immutable snapshot of source, prepared prompt, references, and resolved options. | Activity; previous successful generations become versions of the same creation. |
| Asset | An output file or authorized uploaded reference, with a concrete MIME type, dimensions/duration where available, and storage identity. | Image preview/download, audio player, video player, reference picker. |

The key relationship is **Creation → Generations → Assets**. Source Markdown and optional references belong to the authored item and are snapshotted for each generation. A video may eventually contain scenes/clips, while music may produce both audio and lyrics; these remain inside the item's editor rather than becoming new global navigation sections. Multiple files do not automatically mean multiple Library cards.

First accepted submission puts the same authored item in Library with its current status. A failed first attempt preserves its source and offers recovery; failure does not erase the draft or create an orphan. Drafts remain never-submitted work. Activity lists executions, not a second copy of the content hierarchy. Deleting or dismissing an Activity row must not delete a saved asset.

Regeneration retains the prior successful image as a version of the same item. Selecting a prior version is a compact menu or history action, not another workspace tab strip. Duplicating the item is an explicit separate action. A failed regeneration must leave the prior result usable.

Cross-medium reuse creates a new linked item. “Use image in video” references a specific saved image version; it should not require downloading and uploading again or silently change when a newer image version is generated. “Create image from this text” copies the source into an image draft and records the origin; editing the image brief does not modify the narration's source.

No compulsory Project folder or global standalone Markdown-document layer is needed to generate the first image. The separate video branch may eventually justify projects for multi-part compositions; that is an organization decision to reconcile explicitly, not a prerequisite for every prompt.

## Navigation stays shared across media

| Location | Proposed behavior |
| --- | --- |
| Create | Small menu: Narration and Image in the first release. Add Video and Music as each becomes usable; do not fill the first screen with unavailable modes. Choose a type once when starting a draft. |
| Drafts | One list of unfinished work, with a media filter and type badges. Opening a draft restores its own prompt, references, adaptation choice, and options. |
| Library | One mixed catalog with **All media** as default and a single type filter. Images use thumbnails; video uses poster frames; narration/music use their relevant summary. Images filter may offer a grid, while mixed results retain a scannable list. |
| Activity | Shared status across media. Each row links back to the authored item; media-specific phases stay inside the row. |
| Pinned / Recent / Find work | Include all kinds, retain titles/type/ID context for duplicates, and keep the current bounded lists. They link to stable authored items rather than separate output-file tabs. |
| Settings | Account preferences and available generators. Per-image choices remain in Image options; secrets are not part of the generation form. |
| Existing Playlists / Downloads | Preserve their current behavior for the first image slice. Playlists remain ordered playback lists, not a misleading name for mixed-media collections. A file download and “available offline” are distinct; the current offline module stores narration audio/timings, not generic image/video/music assets. |

No new top-level Images, Videos, or Music rails. Media type is a creation choice and a catalog filter; it is not an accumulating open-document mechanism. A filtered Library can expose a context-specific **Create image** action without making Image a second app shell. A draft's kind stays fixed after submission; creating a different medium copies the source into a separate draft.

Candidate routes are `/studio/image?draft=…` for composing and `/image/:id` for saved image work, alongside the existing narration routes. The exact paths are secondary to stable item identity and preserving browser Back, query/filter/page state, and scroll. A temporary type-specific result route can later resolve through a common media route without making users navigate provider names.

The large-library requirements continue to apply: bounded server reads, 50 visible records per page, lazy thumbnails, compact catalog summaries, and a bounded Find dialog. Add a shared catalog projection or read interface with a stable cross-type cursor. Fetching four complete collections and merging them in the browser would undo the scaling work.

## Image composer: what is visible by default

The core job is **describe an image → generate → see and keep the result**.

1. Choose **Create → Image**.
2. Type or paste a prompt into the main box. Plain text works; Markdown is accepted without requiring syntax or a structured template.
3. Select **Generate image**. A configured, available generator supplies sensible defaults; no model, size, or quality choice is required first.
4. See the large image result, automatically saved in Library. Download is a normal result action. Editing the prompt and generating again creates a new version without overwriting the previous result.

A first view needs only its title/media identity, prompt editor, primary action, and an **Image options** action. A compact summary such as “Wide · Standard · Default generator” can reveal effective settings without expanding the form. Match the engine's current general-image default of Wide 16:9 initially; label this as a chosen product default, not a universal property of images. Pixel-art generators instead use their explicit native canvas, initially 128×128.

Before generation, the editor is prominent. After generation, the image becomes the main focus with a compact, expandable prompt editor nearby for iteration. Do not require switching to a separate source tab to change the prompt. Fullscreen/zoom, download, and Generate again are result actions. Rename, duplicate, details, sharing, provenance export, and future reuse belong in secondary/overflow actions. Keep existing header pin behavior.

Import Markdown belongs to the editor's secondary actions and loads text into the same editor. A reference attachment is optional; once added, show its thumbnail and role near the editor so a material input is not hidden in the panel. The initial flow accepts one separately attached reference because that is the engine's contract. Markdown `![...](...)` links are not automatically uploads or references, and neither first image nor first heading means “generate a separate image.”

Desktop uses the existing right panel with an explicit **Image options** label. It starts closed for images; retain an image-specific preference if the user opens it rather than inheriting narration's global panel state. On mobile, the same options appear in a drawer with a clear Done/close action. Opening or closing settings never submits a generation. There are no image-specific workspace tabs or a generic focus switcher.

## Progressive disclosure within Image options

| Layer | Controls | Default / purpose |
| --- | --- | --- |
| Main screen | Prompt, Generate image, result, Image options summary | Direct prompt-to-image, no configuration required. |
| Image options: prompt preparation | **Adapt notes into a visual brief** toggle; optional custom adaptation instructions revealed when on; optional Preview visual brief action | Off by default. Preserve the user's original text. |
| Image options: visual direction | Optional natural-language style/instructions; modest presets such as “As described,” “Editorial illustration,” or “Photographic,” if useful | “As described” means no added style instructions. These would be product prompt composition, not provider `style` fields. |
| Image options: output | Shape/canvas, resolution, supported background, optional reference | Only show meaningful controls for the chosen generator/model; the common default path needs none changed. |
| Image options: generator | Friendly generator/model selector; available choices supplied by the server | Configured available default. Raw model IDs can be shown in details rather than requiring them as input. |
| Collapsed Advanced section | Exact dimensions, OpenAI quality, Retro-specific pixel style, supported seed, supported generation format | For users who intentionally need them; dependent validation remains near the relevant field. |
| Result Details | Original source, prepared/submitted prompt, resolved options, MIME, dimensions, model/provider, references, request IDs, available usage, versions | Inspectable provenance. Usage is not a universal cost estimate. |
| Account/admin configuration | Enabled providers/models and credentials, service limits, timeouts/recovery | Not ordinary per-image fields. |

The drawer is not a CLI argument dump. Show common intent first, then generator-specific controls only when they become relevant. Group output choices by meaning: general images use shape plus resolution; native pixel art uses width/height. Exact model/provider strings, seed, and format should not compete visually with the source prompt.

Changing provider/model must preserve the user's source. If a reference or transparent background is incompatible, explain the specific conflict and offer an explicit resolution; do not silently discard an attachment or turn off transparency. Reset options should be an explicit action. Saving options as account defaults should also be explicit; new drafts should not accidentally inherit an unusual seed or transparency choice from the last draft.

## Optional adaptation parallels narration without reusing audio instructions

Direct mode submits the user's prompt, with only explicitly chosen visual-direction instructions. It should not silently paraphrase, summarize, or invent a scene. Preserve both the original source and the effective submitted prompt when optional instructions are combined.

When **Adapt notes into a visual brief** is enabled:

1. Preserve the original Markdown exactly as authored in the item.
2. Use a dedicated visual adaptation step to turn notes into a coherent brief for one image: subject, composition, relationships, relevant labels, and requested visual treatment.
3. Apply explicit custom adaptation instructions and visual direction, with recorded precedence; user-specific instructions override the selected style preset, while concrete output settings stay in validated generation fields. Conflicting or unsupported requests should be explained rather than silently “fixed.”
4. Submit the prepared visual prompt to the selected image adapter and save it with the run's source/settings/reference snapshot.

A Preview visual brief action can prepare and show the exact text before generation. It must record which source/options produced that preview, reuse it while unchanged, and invalidate it after edits so the generated image cannot accidentally use a stale preview. Do not force every user through a separate approval screen. The normal enabled path remains one Generate image action with phases **Preparing visual brief → Generating image → Saving → Ready**.

Explain that adaptation adds a text-generation step and may change interpretation. A long pasted article need not reproduce every word in the image; users who need a literal poster/Markdown screenshot need a separate layout/rendering workflow. Rendering Markdown faithfully is not what these image adapters implement.

This requires new engine/application behavior. `GeminiNarrationAdapter` hardcodes an audio-specific user prompt even when its system instruction is overridden; wrapping it with different instructions is the wrong seam. Its pattern can inform a dedicated visual adapter with a small interface that accepts source and optional adaptation instructions and returns a prepared prompt. It should be independent of the image generator: choosing a pixel image model should not require that model to rewrite Markdown. The configured text adapter may need its own available credentials/model, so enabling adaptation must verify that capability rather than assume an image-provider key is sufficient. Keep adaptation/model details server-side unless a user has a useful reason to configure them.

## Engine integration required behind the simple UI

The current shell looks general, but its contracts remain narration-specific:

- [Draft](../studio/src/components/shell/narration-provider.tsx#L36) contains voice, speed, and narration rewrite options; [workspace snapshots](../studio/src/lib/workspace.ts#L14) store `Partial<Draft>`.
- [Pinned/Recent extraction](../studio/src/lib/workspace-navigation.ts#L30) recognizes narration, narration drafts, and playlists only.
- [Library queries](../studio/src/app/api/library/route.ts#L17) read `narrations`, and shared records use `transcript`, `audioPath`, `timingsPath`, and narration status.
- [Generation jobs](../studio/src/lib/use-generation-queue.ts#L17) expose narration IDs, voices, streaming chunks, and narration-specific actions.
- [Context selection](../studio/src/components/shell/app-shell.tsx#L108) and [panel content](../studio/src/components/shell/context-panel.tsx#L63) depend on narration routes.
- [Offline media storage](../studio/src/lib/media-store.ts) operates on audio and narration timings, not arbitrary image assets.

The clean seam is shared identity, catalog summaries, status, drafts, and asset references, with typed medium-specific payloads. Do not add dozens of optional voice/image/video/music fields to one flat draft. Existing narration records can be adapted into the common catalog without immediately rewriting their storage or existing narration/CLI API. The first image slice should exercise this seam with a second real adapter rather than introduce a generic workflow builder.

Invoke the image provider on the server. The filesystem-oriented `runImageGeneration` and image barrel include Node facilities and are not browser code. Reuse request selection and validation, pass authorized uploaded reference bytes to the provider, and save returned bytes to Studio storage. Do not ask the browser for a server-local input/output path. Actual returned MIME decides storage and download format; PNG requested from Gemini is not a guarantee, and this engine does not transcode outputs.

Store source, prepared prompt, resolved settings, and reference asset IDs with each run. The engine's optional metadata file lacks the original prompt/reference and is not sufficient for a Studio document. Store byte size/MIME/dimensions/hash where available, keep sensitive provider/usage details permission-scoped, and record provenance automatically rather than asking users for a metadata path.

Application jobs must survive navigation and refresh. Use the current narration server's completion-independent-of-reader behavior as a reference, while giving images a durable job/result record and duplicate-submit protection. Local activity state alone is insufficient. The engine's common image interface has no progress stream or cancellation signal: show honest phase labels, not invented percentage or a Cancel action that implies the upstream paid request stops. Retries after an ambiguous accepted request must check/recover that job rather than automatically submit another. Retro exposes a recoverable task ID and public poll method; persist its lifecycle receipts in application storage instead of relying on a local CLI output receipt. Other providers require an explicit honest unknown/recovery state when a response is lost.

Only list server-configured, authorized generators. Validate prompt, dimensions, model compatibility, reference bytes/MIME/ownership, and output choices before a paid request. The existing narration allowlist and storage-sharing model do not automatically authorize a new image collection or reference asset endpoint. Images should begin private like other personal creation workflows; sharing remains an intentional result action.

## How the same hierarchy accommodates the other media

| Medium | Core source and result | Secondary controls / distinct child structure |
| --- | --- | --- |
| Narration | Source text → spoken audio and transcript | Reader, delivery, adaptation for the ear, pace; chunks and timings remain implementation/viewer details. |
| Image | Prompt → one still image | Optional visual adaptation; output shape/canvas, reference, visual direction, generator-specific options; prior generations become versions. |
| Video | Storyboard/direction → clip(s) or an assembled video | Shape, first frame, references, task and previous interaction. Scenes/takes/timeline can live within the video item; do not flatten every scene into global navigation. |
| Music | Prompt/lyrics → music audio, optionally returned lyrics | Model/full-versus-clip choice, references, output format. Exact BPM/duration/instrument controls are not standalone fields in the current engine interface; they may be prompt instructions. |

The current video engine really parses Markdown headings into scenes and processes them sequentially, returning a clip per scene; its runner writes separately numbered files, not an automatic composed timeline. The current music engine sends one prompt and returns one audio result plus optional lyrics. Therefore, the app should share navigation and lifecycle while preserving each medium's editor/result structure. Image does not need a timeline; music does not need narration voice controls; video should not inherit image's one-output assumption. Sources: [video interface](../src/video/video-provider.interface.ts), [storyboard parser](../src/chunker/storyboard-parser.ts), [video pipeline](../src/pipeline/document-video-pipeline.ts), [runner](../src/cli/runner.ts#L211), [music interface](../src/music/music-provider.interface.ts), [music pipeline](../src/pipeline/document-music-pipeline.ts).

## Recommended implementation sequence, when authorized

1. **Settle the shared hierarchy and image dependency.** Keep Variant A; agree on the authored-item/run/asset relationship, stable IDs, typed draft migration, and the exact image-provider version/package to use. Reconcile the separate video branch's Create/Projects design without pulling its editor complexity into images.
2. **Build the direct image slice end to end.** Create → Image, one prompt, one configured generator, automatic save, result viewer/download, Library card, typed Drafts/Pinned/Recent/Find, and Activity. Panel starts closed. Source remains recoverable on failure; paid requests are not duplicated by clicks/reloads.
3. **Add prompt preparation.** Optional notes-to-visual-brief toggle, custom instructions, preview, retained original/prepared text, and honest extra-step availability/status. No silent image prompt rewrite.
4. **Expose the engine's real customizations progressively.** Common output controls, a single authorized reference, generator/model selector, then validated per-generator Advanced controls. Introduce additional providers as availability and live validation justify them; the inventory does not require launching all four in the first UI release.
5. **Add the next medium against the same shared catalog and lifecycle.** Specialize its editor/viewer and panel; keep the global destinations unchanged. Add a project/composition layer only when a real multi-item authoring workflow needs it.

Before shipping each slice, verify prompt-only success with the panel never opened; direct mode does not run adaptation; adaptation preserves originals and generates from the prepared prompt; options/draft restore independently; failed regeneration preserves the previous image; job completion survives navigation; ambiguous errors do not cause automatic duplicate billing; unsupported reference/background switches are explicit; mixed catalogs retain bounded reads/search and page/scroll behavior; 320 px layout keeps the prompt, Generate, and options accessible. Test existing narration/CLI/offline behavior independently rather than expecting image support to make all media downloads/offline-capable automatically.

## Uncertainties to resolve during design review

These do not block the proposed hierarchy, but should be explicit before implementation: whether the first image release consumes all of PR #38 or starts with one configured adapter; the image model/account actually enabled on the hosted machine (credentials were not inspected); the exact wording and instructions for visual adaptation; whether “Generate again” history is retained indefinitely or has a user-visible retention policy; and how the separate video branch's Projects concept maps to the chosen navigation. Provider availability, price, reference fidelity, and deterministic outputs were not inferred from API type definitions.

## Appendix: complete engine capability inventory

The following source-backed inventory was produced by the background research pass. New image module references are pinned to the unmerged image-provider commit, not the current Studio runtime.



Investigated 2026-10-09, read-only. Current Studio source is `feature/studio-library-navigation` commit `44f4c693f373d3297eea00a12cd95077c92a905c`. The richer image engine is **unmerged PR #38**, `origin/feat/image-providers`, commit `3a877e380634307c471f571f3ba2039cfe076a1d`. No branch switch, generated media, credentials inspection, or application changes were performed.

References to new `src/image/*` files below are to that exact unmerged commit. Their stable browsable prefix is `https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/`.

### The most important boundary

Current checked-out code has a direct Gemini CLI command, **not a reusable image generation pipeline or Studio image job**. See [`src/cli/command.ts:334`](https://github.com/davideast/mdmedia/blob/44f4c693f373d3297eea00a12cd95077c92a905c/src/cli/command.ts#L334). Its exported MediaType lacks `image`; `src/pipeline/index.ts` exports audio, video, music and sound effects only.

PR #38 adds `mdmedia/image`, exported at package/root level, four adapters, request selection/validation, a filesystem workflow and CLI/config integration. It does **not** add a document image pipeline, Studio storage/auth/job endpoints, or image generation UI. Treat the PR as an explicit dependency rather than capabilities already deployed.

### What Markdown means for images

The entire file is read as UTF-8, trimmed and used as **one prompt for one still image**. Explicit `prompt` takes precedence over `input`; both supplied does not combine them. The new workflow trims explicit prompt too. There is no Markdown AST parsing, heading-to-image split, frontmatter settings, excerpt-selection contract, rewrite/adaptation, automatic document-to-visual summary, or resolution of `![image](path)` references. Formatting, frontmatter and code fences remain literal prompt text. [`src/image/workflow.ts:61`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/workflow.ts#L61).

The only image input is **one separately supplied reference**. SDK takes `{bytes,mimeType}`; CLI/workflow takes one local `referenceImage` path. Markdown uploading is a convenience for supplying prompt text, not a storyboard feature. This makes the honest first UI an editable Markdown creative brief with one Generate image action and one result.

User clarification: default must be direct prompt → image, with an optional “Adapt notes into an illustration” toggle. The direct path matches the implemented engine. The adaptation toggle and custom adaptation instructions are **proposed new product/engine behavior**, not existing image options. Existing `GeminiNarrationAdapter` is audio-specific: its interface is `adaptForNarration`, its user prompt explicitly asks for an audio-narration-optimized script, and default rules verbalize code/diagrams. Overriding its systemInstruction does not make it an appropriate image adapter because that hardcoded audio user prompt remains. `GeminiMarkdownStructureAdapter` only normalizes Markdown while preserving wording verbatim. Neither is a generic prompt-to-visual adapter. Their pattern (model/systemInstruction/customPrompt/temperature and a single transformation method) can inform a dedicated illustration adapter; do not reuse their behavior. Source: `src/narration/types.ts:1`, `src/narration/gemini-narration-adapter.ts:30`, `src/markdown/gemini-markdown-structure-adapter.ts:30`. A new adaptation step must retain original prompt, resulting visual prompt and custom instructions separately, and run only when enabled.

### Complete input/settings inventory

[`src/image/types.ts:5`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/types.ts#L5), [`src/cli/image-command.ts:8`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/cli/image-command.ts#L8).

| Setting | Engine behavior / defaults | UI meaning |
| --- | --- | --- |
| `prompt` / `input` | Nonempty prompt required; a file is a fallback, not an extra prompt. | Main brief editor; Import Markdown secondary action. |
| `provider` | `gemini` default; also `openai`, `retrodiffusion`, `pixellab`. Provider normalization trims/lowercases. Unknown names fail locally. | Generator selector in options, capability-aware. Not separate navigation roots. |
| `model` | Defaults Gemini `gemini-3-pro-image`, OpenAI `gpt-image-2.5-flare`, Retro `rd_fast`, PixelLab `pixflux`. | Provider-specific model in drawer. Changing model can invalidate controls. |
| `aspectRatio` | Gemini/OpenAI default `16:9`; pixel providers have no ratio field. OpenAI maps curated ratios to exact dimensions. | Output shape; pixel-native models instead need actual canvas dimensions. |
| `size` | Gemini unset = provider resolution default; accepts 1K/2K/4K case-insensitively. OpenAI exact `WIDTHxHEIGHT` or `auto`. Pixel providers default `128x128`. | Resolution or native canvas, never one universal size field. |
| `quality` | OpenAI only, `auto` (adapter default), `low`, `medium`, `high`, `xhigh`, `max`. | Advanced quality control shown only for OpenAI. |
| `background` | `auto`, `opaque`, `transparent`; Gemini adapter rejects any explicit value. OpenAI defaults auto. Pixel adapters map only transparent to true, everything else to false. | Transparent background only where supported; auto/opaque are equivalent in pixel adapters. |
| `style` | Retro only; explicit full model-prefixed curated style ID; defaults `${model}__default`. | Retro style picker; not a universal style preset. Natural-language art direction belongs in the prompt for other models. |
| `seed` | Retro/PixelLab only; integer 0–2147483647; optional, including zero. Gemini/OpenAI reject it. | Advanced reproducibility hint; no deterministic guarantee from this engine contract. |
| `referenceImage` / `reference` | One path (workflow) or one bytes/MIME object (SDK). Semantics below. | Optional attachment with role-specific label, not “exact style matching.” |
| `format` | SDK required `png|jpeg|webp`; workflow infers from required output extension. Gemini does not send requested format to API. | Storage/download format, default PNG is a product decision; actual returned format authoritative. |
| `apiKey` | Per-provider config/explicit/env resolution. | Server/account provider configuration; never ordinary per-generation input or browser draft payload. |
| `dryRun` | Workflow validates prompt/ref/settings and returns plan without constructing client, needing credentials, network or output writes. Plan includes full prompt and local paths, excludes key. | Internal preflight capability; no need for a primary user action. |
| `metadata` | Optional local provenance JSON file path. | Result Details / provenance, not a path field in browser. |
| `output` | Workflow/CLI required local output path; SDK returns bytes instead. | UI should save asset through server storage and offer download; no local-machine output path form. |

No count/batch option, no multiple references, no mask, no inpainting region, no negative-prompt field, no reference strength, no compression slider, no grounding/search, no thinking control, no prompt-enhancement service, no resolution-upscale/postprocessor, no live preview or streaming API, no persistent revision/conversation chain. A prompt can request such visual effects in words, but that is not a configurable engine feature.

### Provider/model capability matrix and exact constraints

All constraints below are implemented local validation, not general vendor promises. [`src/image/selection.ts:69`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/selection.ts#L69).

| Provider | Implemented models | Shape / size | References | Background / output | Other |
| --- | --- | --- | --- | --- | --- |
| Gemini | Any nonempty model string; default `gemini-3-pro-image`. No model capability catalog. | Ratios 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. 1K/2K/4K can combine with ratio. | One PNG/JPEG/WebP conditioning image. | No structured background option; requested format ignored; actual first returned image determines bytes/extension. | No quality/style/seed fields; no per-model resolution validation. |
| OpenAI | `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, and either with `-2026-09-08` snapshot. Other names rejected. | Ratio or exact size, mutually exclusive. Custom sides divisible by16; edges ≤3840; longest:shortest ≤3; area 655360–8294400. `auto` allowed. | One PNG/JPEG/WebP, ≤15MiB **engine inline JSON limit**. Switches endpoint to edits. | PNG/JPEG/WebP; auto/opaque/transparent; transparent incompatible JPEG. | Six quality values; 32000-character prompt maximum. |
| Retro Diffusion | `rd_fast`, `rd_plus`, `rd_pro`. | Native dimensions required, no ratio option. Fast/Plus each side64–384, Pro12–256. | Fast/Plus only: RGB PNG without alpha or tRNS. Pro reference rejected by current adapter. | PNG only, transparent via remove_bg. | Model-matching curated styles and seed. Async job and recoverable taskID. |
| PixelLab PixFlux | `pixflux` default | Native sides16–400, area1024–160000. Transparency additionally area≤40000. | One PNG/JPEG init image. WebP rejected for this model. | PNG only; transparent via no_background. | Seed; does not expose strength/palette/negative guidance fields. |
| PixelLab Pixen | `pixen` | Native sides16–768, divisible by4; area≤262144; if any side<32, width must equal height. | None; ref rejected. | PNG only; no PixFlux transparency area cap applied. | Seed; text-only in this adapter. |

OpenAI ratio mapping: 1:1→1024×1024; 16:9→1536×864; 9:16→864×1536; 3:2→1536×1024; 2:3→1024×1536; 4:3→1536×1152; 3:4→1152×1536. Gemini’s 4:5/5:4/21:9 are not mapped by this OpenAI adapter.

Retro exact curated styles (prefix each with `${model}__`): Fast `default,simple,detailed,retro,portrait`; Plus `default,retro,cartoon,environment,isometric`; Pro `default,painterly,fantasy,scifi,isometric`. Prefix-only validation is insufficient; specialized animation/tileset/3D styles deliberately excluded.

Background transparency validated structurally by chosen request fields, not post-verified against output alpha. PNG/JPEG/WebP magic signature validation is not full decode/render validation. Workflow records actual dimensions only for PNG; JPEG/WebP dimensions are absent from current metadata.

### Reference semantics matter to UI

Gemini sends image + prompt together to `models.generateContent`; one image conditions the result, not guaranteed exact style replication. OpenAI reference switches `/images/generations` to `/images/edits`, sends one base64 data URL, and returns one revised image. Retro sends `input_image` initialization to Fast/Plus; strength is not exposed. PixFlux sends `init_image`; provider default influence applies because engine does not send strength. Pixen and Retro Pro have no implemented reference support.

Do not present all of these as one “style reference” switch. A common optional attachment affordance can use contextual descriptions such as “Use an image as a guide” or “Edit this image,” and unsupported model switches must resolve attachments explicitly.

AVIF conversion is only supported by Gemini’s filesystem workflow on macOS using `sips`; this Windows/WSL hosted machine cannot perform it. Browser-upload support must validate PNG/JPEG/WebP and not inherit the CLI’s local path behavior. Validation compares declared MIME to byte signatures before provider calls.

### Configuration and precedence

`.mdmedia.json` is read only in the chosen working directory, not walked up parents. Missing file gives {}; malformed JSON errors. The `image` settings schema is TypeScript-typed but JSON loader does no full runtime schema validation.

Provider: explicit requested → configured image.provider → `MDMEDIA_IMAGE_PROVIDER` → gemini. For the selected provider, explicit non-undefined fields override matching-provider file fields; provider defaults fill missing model/dimensions. API key: explicit image key → matching image config key → legacy top-level key **only for Gemini** → selected provider’s env key. Env keys: GEMINI_API_KEY, OPENAI_API_KEY, RETRODIFFUSION_API_KEY, PIXELLAB_API_KEY. Changing provider discards another provider’s configured key, model, reference and options. Explicitly supplied incompatible fields still fail validation. Requested size replaces configured ratio and vice versa for non-Gemini. [`src/image/selection.ts:32`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/selection.ts#L32).

CLI entrypoint loads `.env` if Node supports loadEnvFile; existing process environment wins. Generic `maxChars`/`maxRetries` do not configure images. Studio needs its own authenticated user/server provider availability/preferences rather than treating the server cwd’s CLI config as a complete product setting model.

### Results, progress, recovery and failures

`IImageProvider.generate(request)` is a Promise of `{imageBytes,mimeType,provider,model,requestId?,usage?}`. No caller cancellation signal, progress callback, phase/status object, or jobID field in common interface. Available usage is `unknown`, not a normalized price or token type. [`src/image/types.ts:43`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/types.ts#L43).

Gemini selects the first image part from the first candidate, discards other content, includes usageMetadata, uses five-minute timeout and SDK attempts1 (installed SDK confirms attempts includes initialcall). OpenAI sends `n:1`, reads data[0].b64_json, captures requestID and usage. PixFlux/Pixen are synchronous, read image.base64, capture requestID and usage. Shared HTTP client has five-minute defaulttimeout, optional injection of fetch/sleep/timeout/pollinterval for SDK callers, no automatic POST retries, redacted transport errors, and HTTP status/code/requestID when available. It does not normalize moderation vs quota vs invalid-request failures into typed product errors or honor Retry-After. [`src/image/http.ts:8`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/http.ts#L8).

Retro submits one async V2 inference with a generated Idempotency-Key. Optional lifecycle hooks await pre-submit receipt and admitted task receipt before polling pending/running every2s until succeeded/failed/deadline. Success decodes base64 or downloads HTTPS output without forwarding credentials. Errors after admission include taskID and instruct retrieve before generatingagain. Public `RetroDiffusionImageProvider.poll(taskId,model,requestId?)` can recover an existing job without a new paid submission. [`src/image/retro-diffusion-image-provider.ts:21`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/retro-diffusion-image-provider.ts#L21).

Filesystem workflow writes `<output>.job.json` for Retro before submission (exclusive create) then accepted task metadata. Existing receipt blocks another submit at that path. Receipt contains key, task/request IDs, model/provider and request hash, not credentials/prompt/reference bytes. It is not marked complete or automatically removed after success. There is no CLI retrieve/resume command wired to public poll method. An ambiguous transport failure is not proof no image/job was created.

Workflow writes actual MIME-suffix image file; it does not transcode. It creates output dirs, can overwrite existing image paths, and has no generic idempotency or atomic asset/database transaction. Optional JSON sidecar has version, provider/model, requested settings, actual path/MIME/PNGdimensions/byte count/SHA256, requestID and available usage; excludes prompt, reference and key. Thus metadata alone cannot recreate a Studio brief. Persisting source, references and immutable resolved settings per run is necessary product work. [`src/image/workflow.ts:95`](https://github.com/davideast/mdmedia/blob/3a877e380634307c471f571f3ba2039cfe076a1d/src/image/workflow.ts#L95).

### SDK / CLI / Studio integration distinctions

SDK low-level provider uses byte input/output; filesystem workflow requires local prompt/ref/output paths. The public image barrel reexports Node filesystem/crypto workflow and Node-oriented adapters (Buffer), so it is not a ready browser-safe client module. Prefer server-side engine invocation with credential isolation and upload/storage services. App needs durable jobs and result persistence independent of current route, duplicate-submit protection, honest coarse phases, retry/recovery policy, reference authorization, and a result viewer. No image pipeline plugs into existing pipeline-event-bus.

This does not require building a generic workflow designer. A thin application-level create-image job can wrap one immutable ImageRequest and one asset, while future narration/video/music adapters provide medium-specific payloads under shared draft/run/asset concepts.

### External documentation checked today

The PR includes substantial earlier primary-source research in `plans/image-provider-research.md` and scope/tests/live-smoke records in `plans/image-provider-integration.md`. I additionally opened public official docs (no authenticated API calls):

- [OpenAI Flare model](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) confirms exact Flare/snapshot ID and six quality choices. [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation) confirms custom-size constraints and transparent PNG/WebP. These support engine fields, not every advertised model ability.
- [Google image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation) confirms `gemini-3-pro-image` exists, 1K/2K/4K generation, and broader references/grounding/thinking/interleaved capabilities. Those broader capabilities are **not implemented by this image adapter**. Current CLI description mentioning Flash despite Pro model default is imprecise.
- [Retro official V2 migration](https://raw.githubusercontent.com/Retro-Diffusion/api-examples/main/V2_MIGRATION.md) and [official summary](https://raw.githubusercontent.com/Retro-Diffusion/api-examples/main/llms.txt) document async admission/task polling and hosted outputs. Vendor Pro/multi-reference/animation features exceed this adapter.
- [PixelLab public OpenAPI](https://api.pixellab.ai/v2/openapi.json) exposes more controls such as init strength/palette and more endpoints. [PixFlux official docs](https://www.pixellab.ai/docs/tools/create-image-flux) confirms account-tier area limits; engine validates maximum tier-wide area and does not discover actual account tier. UI should not imply every permitted engine size is available on every connected account.

Existing PR record reports live OpenAI generation/edit smoke validation; Retro and PixelLab remain documented/mocked, not live-validated. This research did not repeat those calls or verify visual quality. Do not make account-specific availability, pricing, duration, reference-fidelity or determinism promises based on these sources.
