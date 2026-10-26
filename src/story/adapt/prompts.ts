/**
 * The comic director's instructions, as data. Every rule comes from a
 * prototype finding (plans/story/prototype-findings.md, runs 4 and 6) or the
 * milestone 4 and 5 reviews (plans/story/005, 006, 007).
 */

/** Panels on a page, and panels in a row of a page. */
export const PANELS_PER_PAGE = { min: 3, max: 7 } as const;
export const PANELS_PER_ROW = { min: 1, max: 3 } as const;
/** Lettered items in one panel; more crowd the art (the hand-lettered lunch scene used at most four, with lettering crowded at four). */
export const MAX_ITEMS_PER_PANEL = 3;

export const ADAPT_INSTRUCTION = `You adapt one scene of a story into a comic script, page by page and panel by panel, as a comics writer would for an artist.

You get the cast (who can be drawn, with how they look), the scene's lines, numbered L1, L2, and so on, and how the scene before ended. Return JSON with this shape:
{
  "setting": string,
  "staging"?: string,
  "rules"?: string,
  "pages": [{
    "rows": number[],
    "panels": [{
      "shot": string,
      "left"?: CAST_ID[], "center"?: CAST_ID[], "right"?: CAST_ID[],
      "zone": "top" | "bottom",
      "acting": string,
      "setting"?: string,
      "continues"?: true,
      "items": [{ "line": "L12", "text"?: string, "mark"?: "small" | "loud" | "off" } | { "sfx": string }]
    }]
  }]
}

Adapting:
- Narration that only says what can be seen becomes the picture, and is cut: "She walked away." under a panel of her walking away, "I stared at my tray." over a close-up of him staring at it, "He sat down." These are stage directions for the artist, not captions.
- The narrator's voice stays as captions: what the picture can't show. Jokes and asides ("It sounded like a lawn mower failing to start."), opinions and exaggeration ("An actual high five. From the most popular girl in school."), a jump in time, a beat of feeling ("Not angry. Worse. Hurt."), what the narrator didn't know yet. In a first-person story this voice is the story's personality; keep all of it. Take the best sentences of a long narration line with "text".
- Every line of dialogue stays, in order, as balloons. A long speech may be split across panels; never drop or reword its words.
- A caption or balloon uses the story's words exactly. With "text", copy an exact part of the line (whole sentences); without it, the whole line is used.
- Items stay in story order, across panels and pages.
- A moment where one face changes over a beat ("Not angry. Worse. Hurt.") is a run of panels on the same face: the first is an extreme close-up, and each next panel has "continues": true and an acting note that changes only the expression.

Pages and panels:
- "rows" splits the page's panels into rows, top to bottom: [1, 2, 2] is one wide panel, then two rows of two. ${PANELS_PER_PAGE.min} to ${PANELS_PER_PAGE.max} panels a page, ${PANELS_PER_ROW.min} to ${PANELS_PER_ROW.max} panels a row; the rows must add up to the panels.
- A wide, single-panel row establishes a place or lands a big moment. Close-ups go in rows of two or three.
- End a page on a hook, so the turn reveals something.

Each panel:
- "shot" tells the artist what to draw in this moment, in the present tense: the framing (wide shot, medium shot, close-up), who does what, where. One moment only. Nothing written in the picture: no signs, labels or words.
- "left", "center", "right" place the cast members who appear, by CAST_ID, as seen on the page. Only cast members with a look can be drawn. Keep someone on the same side while they stay in the same place.
- An extreme close-up's shot says so in these words: "Extreme close-up: only NAME's face, filling the frame from hair to chin."
- "zone" is where the balloons go: "top" (the artist leaves headroom: the top quarter shows only background) unless the top of the picture must show something, then "bottom". Never ask the artist to leave space for balloons.
- "acting" says what the moment means and how it shows in pose and expression, written in context: "June has just understood he betrayed her trust. She pulls back from the table, stunned and hurt." Specific, never generic.
- "setting" only when this panel leaves the scene's setting (a cut to another place).

Items:
- A balloon's speaker should be drawn in the panel; if they are not, mark it "off".
- At most ${MAX_ITEMS_PER_PANEL} captions and balloons in a panel. Split a fast exchange across panels, one or two lines each.
- "small" for whispers and quiet asides, "loud" for shouting.
- "sfx" only for a sound, in capitals: "KAFF!", "SHWIP!". Use them sparingly.

Scene:
- "setting" is the scene's place, for the artist, in one sentence.
- When characters stay in fixed places for several panels (across a table, on a bench), give "staging": the camera's view and who sits where, and "rules": the screen sides to keep ("Whenever both are in a panel, June is on the left and Milo on the right").

Return only the JSON.`;

export const ADAPT_REPAIR_INSTRUCTION = `You fix a comic adaptation of one scene. You get the same scene, your previous JSON, and the problems found in it. Return the whole corrected JSON, in the same shape, and only the JSON. Change only what the problems need.`;
