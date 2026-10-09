# Image provider integration research

Researched 2026-10-07 from public, first-party documentation. No credentials were read and no generation, cost-estimate, or authenticated API requests were made. “Pixel Labs” is interpreted as **PixelLab**, the pixel-art service at pixellab.ai. These findings describe the documented contracts; account access and real generated-image behavior remain untested.

## Findings and recommended scope

Keep `mdmedia image` and its Gemini default compatible. Add an explicit provider selector and adapters for OpenAI, Retro Diffusion, and PixelLab. Initially generate one still image per invocation. Pixel-native dimensions need a separate `--size WIDTHxHEIGHT` flag; Gemini's aspect-ratio flag cannot accurately express a 32×32 sprite versus a 256×256 scene. A common command should expose supported capabilities and reject unsupported combinations before submission.

**GPT Image 2.5 is verified**, but that family name is not the documented API ID. OpenAI released **Flare** for everyday generation and **Sunburst** for more precise premium editing on September 8, 2026. Select their exact IDs. [OpenAI announcement](https://openai.com/index/introducing-chatgpt-images-2-5/)

## OpenAI GPT Image 2.5

Use `gpt-image-2.5-flare` as the new OpenAI adapter's default and allow `gpt-image-2.5-sunburst`. Dated snapshots exist as `gpt-image-2.5-flare-2026-09-08` and `gpt-image-2.5-sunburst-2026-09-08`. `POST https://api.openai.com/v1/images/generations` accepts JSON with explicit `model`, `prompt`, and `n`; one output means `n: 1`. Options include `size`, `quality`, `background`, `output_format`, and JPEG/WebP `output_compression`. The legacy `response_format` is unsupported for GPT Image. Output is `data[].b64_json`, with optional resolved settings and usage. [Generation reference](https://developers.openai.com/api/reference/resources/images/methods/generate)

Reference-image requests use `POST /v1/images/edits`. The current JSON contract accepts `images: [{ image_url: "data:image/png;base64,..." }]`; up to 16 images are supported. File IDs and multipart file uploads are also documented. Authenticate using `Authorization: Bearer <OPENAI_API_KEY>`. A local reference does not require a separate Files API upload when sent as a data URL. [Edit reference](https://developers.openai.com/api/reference/resources/images/methods/edit)

Valid custom sizes have sides divisible by 16, maximum edge 3840, aspect ratio between 1:3 and 3:1, and area 655,360–8,294,400 pixels. Above 2560×1440 is experimental. Quality supports `low`, `medium`, `high`, `xhigh`, `max`, and `auto`. PNG is default; JPEG and WebP are supported. Transparent backgrounds require PNG or WebP. Direct Images requests suit this CLI better than a Responses conversation. Complex requests can take two minutes. Some organizations need verification. User errors, including moderation blocks, should not be automatically retried unchanged. [Image guide](https://developers.openai.com/api/docs/guides/image-generation)

Standard pricing for both variants is $8/million image input tokens, $30/million image output tokens, and $5/million text input tokens. Equal rates do not imply equal per-image cost. Cached rates and Batch pricing are separate; do not present a fixed generation price as a guarantee. [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

## Retro Diffusion

New integrations should use `https://api.retrodiffusion.ai/v2`. `POST /inferences` is always asynchronous for paid generation. Admission returns `task_id`; poll `GET /inferences/tasks/{task_id}` until `pending`/`running` becomes `succeeded` or `failed`. Success contains `result`. V2 HTTP errors use `error: { code, message, request_id }`; failed task reads remain HTTP 200 with an embedded error containing `status_code`, `code`, `message`, and `request_id`. Preserve request IDs and `Retry-After`. V1 remains supported, but do not retry a paid V2 failure through V1. [Official migration guide](https://raw.githubusercontent.com/Retro-Diffusion/api-examples/main/V2_MIGRATION.md)

Authenticate with `X-RD-Token`. A still-image payload needs `width`, `height`, `num_images: 1`, `prompt`, and `prompt_style`, e.g. `rd_fast__default`. Optional fields include `seed`, `remove_bg`, raw-base64 PNG `input_image` with `strength` 0–1, and RD Pro `reference_images` (up to nine). Input images are documented as RGB without transparency. Fast/Plus default styles allow 64–384px per side; Pro default allows 12–256px. Use style-specific limits, not the API's broad limit. Poll approximately every two seconds. Decode `result.base64_images` **or download `result.output_urls`**: hosted output can replace inline base64 automatically. Outputs are retained for 24 hours. Persist an `Idempotency-Key` before submission and reuse it only for identical uncertain submissions. Once admitted, poll rather than resubmit. Published flat per-image prices are Fast $0.03, Plus $0.06, Pro $0.18; exceptions exist. Free `check_cost` is documented, but was not called. [Official API summary](https://raw.githubusercontent.com/Retro-Diffusion/api-examples/main/llms.txt)

The proposed still-image adapter should begin with a curated subset of Fast, Plus, and Pro still-image styles. Animation, tileset, edit-tool, and 3D styles require different inputs and outputs and deserve separate commands. The style selector can become an explicit discovery command later; adding a network-dependent discovery call to every dry run would weaken offline planning.

### Curated still-image styles

| Model | Allowed style IDs | Width and height, independently | Input/reference behavior |
| --- | --- | --- | --- |
| Fast | `rd_fast__default`, `rd_fast__simple`, `rd_fast__detailed`, `rd_fast__retro`, `rd_fast__portrait` | 64–384px | Init image optional; no Pro reference mode |
| Plus | `rd_plus__default`, `rd_plus__retro`, `rd_plus__cartoon`, `rd_plus__environment`, `rd_plus__isometric` | 64–384px | Init image optional; no Pro reference mode |
| Pro | `rd_pro__default`, `rd_pro__painterly`, `rd_pro__fantasy`, `rd_pro__scifi`, `rd_pro__isometric` | 12–256px | Init optional; up to nine references |

These are ordinary still-image styles. Keep `num_images: 1`; do not enable spritesheet, original-background, or pre-palette extra output options. The static catalog documents no additional square or divisibility restriction for this subset. The generic `remove_bg` option produces transparent output; no further background size restriction was found for these styles. Restrict validation to the explicit allowlist: a family-prefix match also admits specialized sheet, editing, or unsupported IDs. [Official model catalog and request fields](https://raw.githubusercontent.com/Retro-Diffusion/api-examples/main/README.md)

An unauthenticated read of the live `/v2/styles/selector` returned 401. The limits above therefore come from first-party static documentation; future account-specific discovery should be separate from offline dry runs.

The official img2img example explicitly uses `rd_plus__default`, forbids a data-URL prefix, and says RGB without transparency **works best**. That last wording is preparation guidance, not proof that every RGBA input is rejected. A PNG init image should be prepared as RGB or rejected locally with a conversion instruction; avoid silently discarding transparency. The official Pro example explicitly uses `rd_pro__default` with content/style references rather than redraw input. Do not transfer the init-image RGB guidance to Pro references without additional evidence. [Img2img example](https://raw.githubusercontent.com/Retro-Diffusion/api-examples/main/example-scripts/03_img2img.py), [Pro reference example](https://raw.githubusercontent.com/Retro-Diffusion/api-examples/main/example-scripts/04_reference_images.py)

## PixelLab

The official API lists PixFlux (`/v2/create-image-pixflux`), Pixen (`/v2/create-image-pixen`), BitForge (`/v2/create-image-bitforge`), and Pro (`/v2/generate-image-v2`). PixFlux supports init images and palettes; Pixen emphasizes larger text-generated canvases; BitForge supports style references and inpainting. Public example costs are estimates, not fixed quotes: PixFlux 128×128 approximately $0.00793, Pixen 128×128 approximately $0.00793, and Pro ≤256×256 approximately $0.095. [PixelLab API catalog](https://www.pixellab.ai/pixellab-api)

The public OpenAPI schema confirms Bearer authentication. Synchronous PixFlux/Pixen/BitForge requests require `description` and `image_size: { width, height }`; all accept `no_background` and `seed`. Responses contain `image: { type: "base64", base64, format }` and `usage`; examples include a data-URL prefix. PixFlux `init_image` is a `Base64Image` object, with `init_image_strength` 1–999, default 300. Pixen has no reference/init field. Pixen requires dimensions divisible by four, sides 16–768, area ≤512², and square output if either side is below 32. PixFlux's asynchronous equivalent `/create-image-pixflux-background` returns `background_job_id`; poll `/background-jobs/{id}` every 5–10 seconds for `processing`, `completed`, or `failed`; completed results live in `last_response.image`. Pro is asynchronous and returns size-dependent multiple candidates. Documented errors include 401, 402, 422, 429, and synchronous 529. Usage can be USD or subscription generations. No idempotency guarantee was found. [Public OpenAPI schema](https://api.pixellab.ai/v2/openapi.json), [interactive reference](https://api.pixellab.ai/v2/docs)

PixFlux canvas area must be at least 32²; account tiers limit maximum area to 200² (free), 320² (tier 1), or 400² (tier 2+). The schema permits sides 16–400, so area validation is also necessary. PixFlux describes transparent output above 200² as a blank background; verify this later before advertising large transparent sprites. [Official PixFlux documentation](https://www.pixellab.ai/docs/tools/create-image-flux)

Recommend PixFlux as PixelLab's initial default because it offers one output and init-image support; expose Pixen as a text-only choice. Reject `--ref` with Pixen. Do not describe a PixFlux init image as guaranteed style matching: the existing Gemini flag's promise is too strong across providers. Defer Pro until candidate selection and style-reference roles have a deliberate interface.

## Flag and output decisions

| Surface | Recommendation | Reason |
| --- | --- | --- |
| `--provider` | Explicit `gemini`, `openai`, `retrodiffusion`, `pixellab`; preserve Gemini default | Avoid silently changing existing cost, credentials, or rendering behavior |
| `--model` | Provider-specific exact IDs; Retro styles have a separate `--style` | Retro's style determines model and constraints |
| `--aspect` | Preserve Gemini behavior; map OpenAI to valid dimensions; reject with pixel providers | Native pixel dimensions carry artistic meaning |
| `--size` | Gemini `1K|2K|4K` presets; others exact `WIDTHxHEIGHT`; validate provider constraints before credentials/network | Enables reproducible sprites and OpenAI custom resolution |
| `--ref` | Preserve existing single local path; document provider semantics | Edit input, init image, and Pro reference are different concepts |
| `--quality` | OpenAI only; include `xhigh` and `max` | There is no equivalent universal provider field |
| `--background` | Common opaque/transparent choice, map to provider fields | Enables usable cutout assets without hiding format constraints |
| `--seed` | Pixel providers only | OpenAI Images does not document a seed field |
| `--dry-run` | Local validation and request summary; no key, network, generation, or cost-estimate calls | Provides the requested zero-spend review path |
| Output file | Write actual image bytes with matching extension; default lossless PNG for new providers | Renaming PNG bytes to JPG breaks downstream tooling |
| Optional JSON/sidecar | Include provider, exact model/style, requested/resolved size, MIME, request/job ID, available usage/cost | Makes outputs traceable without storing credentials or base64 |

Recommended verification is mocked HTTP contract tests covering synchronous base64, data URLs, asynchronous success/failure/timeout, URL output, unsupported flags, and offline dry runs. Paid visual evaluation, account-tier behavior, exact pixel-grid quality, and reference fidelity remain a later explicit user-authorized step. Generation POSTs should not automatically repeat on ambiguous failures; report any known job ID so the user can recover a potentially billed result.
