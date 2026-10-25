# Plan 007: Performance briefs, voice casting and lettering fixes

## Status

- **Category**: feature and fixes, from review of the milestone 5 readers
- **Branch**: `feat/story-casting` (from `feat/story-m5`), local only
- **Status**: DONE (as built below)

## Why

Review of the three readers found:
- **Lettering:** tails pointing at the wrong character, a caption over a face, words outside their balloon.
- **Voices:** Odile in a man's voice, the children sounding like adults, "Nerw" said as "Nair-rem".

The voice cause: the director cast from Gemini's one-word voice labels and wrote one-phrase deliveries ("Gruff, brisk elderly woman").

## Evidence (voice auditions, 2026-10-23..25)

- **Round 1** (5 characters × 3 voices × flat vs brief): briefs were better. A respelling in the text beat a pronunciation note in the brief "across the board".
- **Round 2** (all 30 voices per character, deeper briefs, an audio model scoring each take):
  - The brief changes apparent gender and age. Enceladus scored as "a convincingly elderly Northern female voice" for Odile and as a natural child for Wren.
  - The judge's scores ran 0 to 10, and its notes were specific: it called Gacrux "a raspy adult male" when asked for an eleven-year-old girl, matching what David heard from Odile.
  - No brief was refused or spoken aloud.
- **Feedback:** David wants briefs with more texture (accent from a place, nasality, laugh, habits), and doesn't want to pick voices from a grid.

## As built

- **Story format:**
  - `brief:` on cast members and the narrator; it is sent with every line in place of `delivery`.
  - `voice:` is optional and may name another cast member to share a voice (`NERW: voice: WREN`).
  - `pronounce:` maps words to respellings for the voice; the check maps heard respellings back.
  - `missing-voice` is reported when a member has neither a voice nor a brief.
- **`castVoices`:**
  - Every Gemini voice auditions the character's first line with the brief.
  - A `VoiceJudge` (Gemini, `gemini-3.5-flash`) scores who, accent, texture and fit.
  - The most confident casts choose first, and each character gets their best voice that no one else has.
  - Results are cached until the brief or the sample changes.
  - `story build` and `story comic` cast before voicing, and record every audition in their build reports.
- **Director:** writes briefs to the depth above (with an example) and no longer picks voices.
- **Fixtures:** 17 briefs across the three stories; Nerw respelled "Nur-oo".
- **Lettering:**
  - A speaker not drawn in the panel gets a tail out of the frame.
  - Ovals are sized so every line fits inside the ellipse.
  - Head boxes are keyed by the image itself.
  - A failing panel keeps its best take between builds; `--redraw` asks for a new one.
- **Vision robustness:**
  - Gemini blocks (`PROHIBITED_CONTENT`) a request describing a fourteen-year-old's age and body beside an image of her. Checks and head boxes now use `visualLook()` (hair, clothes, props), and head boxes fall back to names only.
  - Empty answers are retried; blocked ones are not.
  - Head-box failures no longer fail a build: panels without them are counted in the build report.

## Live runs (2026-10-25)

| Comic | Cast (voice) | Lines failing | Notes |
| --- | --- | --- | --- |
| Wren Backwards | Wren/Nerw Pulcherrima, Odile Leda, Gilbert Puck, Pim Zubenelgenubi (7/10, "slightly older than twelve"), Narrator Orus | 1 (plaice/place) | 5 panels redrawn after the check wording changed |
| Lunch | Milo Enceladus, June Achird, Harper Algenib, Alvarez Umbriel, Tech kid Despina, Kid Orus | 1 ("just to Harper") | |
| Midnight Line | Akari Callirrhoe, Sora Rasalgethi, Tama Orus, Stationmaster Aoede, Fuji Zephyr (was Rasalgethi, shared with Sora, before one-voice-per-character), Crow Puck | 2 (fare/fair) | Took four runs: Gemini quota (429), then blocked check requests |

A full cast is about 30 auditions per character: Midnight Line's six characters took about 16 minutes. Gemini quota is the practical limit.

## Open

- Your ear is the real test of the casting; the judge's notes are the only evidence so far.
- Homophones in transcript checks (fare/fair, plaice/place).
- The same cast voice can appear in two stories (Orus narrates Wren Backwards and plays Tama); that is fine across stories.
