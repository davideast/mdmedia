# Image provider integration

## Objective and review boundary

Integrate GPT Image 2.5, Retro Diffusion, and PixelLab into mdmedia's existing image CLI and public TypeScript library. Research uses public first-party documentation. Initial implementation and validation on October 7 must not call a paid generation endpoint; subsequent live validation requires explicit user authorization. Existing workspace changes belong to the user and must be preserved. Nothing is published externally.

## Findings and decisions

- The current `image` command directly constructs a Gemini client. It has no reusable image interface or image config section, silently ignores missing references, and writes returned bytes under any requested extension.
- Keep `image`, `--prompt/-p`, `--input/-i`, `--output/-o`, `--model/-m`, `--ref/-r`, `--aspectRatio/-a/--aspect`, and `--apiKey/-k`. Keep Gemini and its existing model/aspect defaults so existing scripts retain their selection.
- Add explicit `--provider gemini|openai|retrodiffusion|pixellab`. Do not infer a vendor from a model string. An explicit vendor switch discards the other vendor's configured model, key, and settings.
- GPT Image 2.5 has named Flare and Sunburst models. Use `gpt-image-2.5-flare` as the OpenAI default for everyday generation, following the official prompting guide; allow Sunburst and dated snapshots through `--model`. Never submit the ambiguous `gpt-image-2.5` label.
- PixelLab.ai is the pixel-art provider intended by “Pixel Labs.” Use its public REST API rather than a paid MCP session or an editor automation.
- Pixel art needs native pixel dimensions, not a cinematic default ratio. Add `--size WIDTHxHEIGHT`, with provider-specific validation; `--aspect` applies to Gemini/OpenAI. Gemini preserves its `1K|2K|4K` resolution presets combined with aspect; OpenAI rejects conflicting dimensions locally.
- Expose `--quality` for OpenAI, `--style` for Retro Diffusion, `--seed` where supported, and `--background auto|opaque|transparent` where supported. Unsupported options fail before submission rather than being silently ignored.
- `--ref` remains a single local image. Its meaning follows the provider: Gemini conditioning, OpenAI image editing, and pixel-art initialization where supported. Missing/unsupported references must fail locally.
- Generate one still image per invocation. Native animations, characters, tilesets, and sprite atlases need their own future contracts; do not flatten them into a single PNG.
- Add `--dryRun`: load prompt/config/reference, resolve settings, validate and print a redacted plan without credentials, network, or output writes. Examples for this review use this flag.
- Normalize provider responses to bytes plus actual MIME type and provenance. Save every still image as a file with the actual format's extension; if Gemini returns a different format, correct the suffix and report the real path. Pixel outputs remain native resolution without interpolation. Add optional `--metadata` JSON sidecar for provider/model/size/request ID/usage, without credentials or image payloads.
- Async providers submit once and poll existing jobs. Never automatically retry paid POSTs or fall back to a different provider/model. Bound waits and report IDs on polling failure so a user knows a job may already exist. Retro writes `<output>.job.json` with an idempotency key before submission and a task ID on acceptance; an existing receipt prevents another submission to the same output. Its library `poll` method supports recovery.
- Add `.mdmedia.json` `image` settings and provider-specific environment keys, plus `mdmedia/image` package export. Keep studio integration as reusable library groundwork: the current Studio accepts images as references but has no image generation job/UI contract.

## Execution plan

1. Capture official endpoint, authentication, request/response and limits evidence in [research notes](image-provider-research.md).
2. Build typed image requests/results, selection and validation, adapters for the four providers, bounded HTTP polling, and format-aware local output writing.
3. Replace the inline CLI implementation with the image workflow; wire configuration and exports; document flags, native size defaults, reference semantics, corrected output paths and dry-run examples.
4. Verify adapter wire contracts with injected fake transports/clients. Cover config precedence, credential isolation, invalid options, provider errors, async completion/failure/timeout, references, image signatures, and CLI dry-run with no credentials/network.
5. Run typechecking, package build and the offline test suite. Review the final changes and record limitations and results here.

## Acceptance gates

- All three requested providers are selectable through CLI and library, alongside Gemini.
- Official documented IDs/endpoints/fields are used; no invented API or silent unsupported setting.
- Configuration and local validation work without a paid request.
- Dry-run is demonstrably credential-free and leaves no output artifacts.
- Credentials never appear in dry-run or metadata and never cross providers.
- Actual image format and output filename agree.
- Async errors never cause a second generation submission.
- Existing audio/video/music and user workspace changes remain intact.
- Initial validation uses only fake generation clients/transports; no API spend. Later paid tests require explicit authorization and remain opt-in.

## Completion record

Implemented locally on 2026-10-07. No generation, estimate, or authenticated provider API requests were made. No changes were published or committed; the existing user changes are preserved.

- Added the public `mdmedia/image` module and four provider adapters, selection/validation, format-aware output writing, optional provenance metadata, and the shared image workflow.
- Replaced the inline CLI image code and added image configuration, exact model selection, native pixel sizes, supported provider controls, and both `--dryRun` and `--dry-run` aliases.
- Added Retro's pre-submission receipt, admitted task recovery data, single submission/polling, credential-free hosted-image downloads, and curated still-image styles. Existing receipts prevent accidental resubmission for the same output.
- Added mocked provider contract tests and real CLI dry-run tests. The focused image/config suite passed **50 tests**, with no failures.
- Full source typecheck and production build passed. Core verification passed **22/22** checks. The actual npm tarball consumer harness passed **14/14** checks, including the packaged GPT Image 2.5 dry-run, image runtime exports, and public TypeScript declarations.
- The contract audit found and resolved repeated OpenAI aspect-to-size validation and Retro RGB PNG transparency validation (`tRNS`). Both now have regression coverage.
- Final broad suite: **625 passed, 12 paid E2E tests skipped, 1 failed** across 108 files. The remaining failure is the pre-existing Queue page layout assertion in `test/studio/view-grid-alignment.test.ts`; that assertion reads Studio source already modified before this task. This integration changes no Studio source. Local server/clipboard checks passed with sandbox restrictions removed, and the existing startup and production CLI checks passed with dependencies available.

### Review and later paid validation

The CLI and library integration is ready for review. It covers one still image per request. The Studio image generation job/UI, native animations, sprite atlases, tilesets, PixelLab Pro candidate grids/BitForge, Retro Pro style-reference controls, and multiple references are deliberately deferred because they require additional output or reference-role contracts.

After explicit spend authorization, run low-cost smoke tests and inspect output dimensions, alpha channel, actual quality/pixel grid, reference influence, account tier and access restrictions, and reported usage. OpenAI's generation and editing paths were verified on October 8 as recorded below; Retro Diffusion and PixelLab still require authorized live validation. Account-specific pricing is not estimated by the dry run.

### OpenAI live validation — October 8

The user authorized OpenAI API tests using their existing `OPENAI_API_KEY` on October 8. The opt-in test in `test/image/openai-e2e.test.ts` submits at most two requests: one Flare PNG generation and one Sunburst reference-image edit to transparent WebP, both low quality at 1024×1024. It records checkpoints before requests and preserves images, available usage and request IDs under the Git-ignored `test/image/e2e-output/` directory. Credentials are passed through the process environment and never written to reports. Retro Diffusion and PixelLab remain untested live.

Both live requests passed in 23.7 seconds total: Flare generated a 1024×1024 PNG in 9.9 seconds; Sunburst edited that reference into a 1024×1024 transparent WebP in 13.7 seconds. The CLI reported the correct paths, and metadata retained request IDs, usage, MIME types and output hashes without the key. Independent decoding confirmed 806,506 fully transparent pixels (76.9% of the edit). Visual inspection over a checkerboard confirmed the preserved teal robot, red antenna and removed background. This is a low-quality smoke test, not comprehensive model fidelity coverage.

Estimated standard-rate cost from returned token usage is **$0.020482**: $0.006095 for Flare and $0.014387 for Sunburst. This uses text input $5/million, image input $8/million and image output $30/million from the official [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) and [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) model pages; it is an estimate rather than an invoice.

The retained local run is `test/image/e2e-output/openai-EdnfeL/`, containing both original outputs, metadata, `report.json`, independent `inspection.json`, and a checkerboard inspection preview. The source test preflights macOS `sips` before spending. Subsequent credential-free regression validation passed **50 tests, 1 live test skipped, 0 failures**, and source typechecking passed. No other provider was called.

### Pull request preparation — October 9

Prepared an isolated branch against current `main`, preserving its sound-effects command, environment loading, and storyboard path fixes. Gemini retains the upstream `--size 1K|2K|4K` presets (case-insensitive) alongside `--aspect`; the shared adapter sends `imageConfig.imageSize`. Existing `imageGenerationConfig` imports remain compatible. Added offline coverage for Gemini selection precedence and the actual SDK request. Paid smoke tests were not repeated. Other workspace changes and live output files are excluded from the PR.

Final isolated-branch verification: **517 passed, 16 skipped, 0 failed** across 91 files; the targeted image/config/Gemini compatibility/sound-effects suite passed **71 tests**, with 1 paid image test skipped. Full source typecheck passed. Production build and npm tarball consumer verification passed **14/14** checks. The earlier Queue failure belonged to excluded workspace changes and does not reproduce in this isolated PR. No credentials or generated outputs are committed.
