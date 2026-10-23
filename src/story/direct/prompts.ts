import { VOICES } from './voices.js';

/**
 * The director's instructions, as data. Every rule here comes from a
 * prototype finding (plans/story/prototype-findings.md) or a listening note.
 */

export const CAST_INSTRUCTION = `You cast an audio drama from an author's story.

Read the whole story and return JSON with this shape:
{
  "title": string,
  "author"?: string,
  "narrator": { "character": CAST_ID } | { "voice": VOICE, "delivery": string },
  "cast": { CAST_ID: { "voice": VOICE, "delivery": string, "look": string } },
  "names": string[],
  "scenes": [{ "title": string, "firstWords": string, "music": string }]
}

Rules:
- CAST_ID is the character's name in capitals, one word if possible (MILO, JUNE, MR_ALVAREZ becomes ALVAREZ).
- If the story is told in the first person, the narrator is that character: use { "character": CAST_ID }.
- Unnamed voices that speak (a kid in a crowd, a voice offstage) get short ids such as KID or VOICE.
- "delivery" describes how the character always sounds: age, temperament, manner. It is said before every line, so keep it to one phrase.
- "look" describes how the character looks in one phrase: hair, clothes, one distinctive detail. Leave it empty for voices nobody sees.
- VOICE must be one of these Gemini voices. Match the voice to the character:
${VOICES.map((v) => `  ${v.name}: ${v.description}`).join('\n')}
- Give different characters audibly different voices.
- "names" lists every other proper noun in the story a listener might hear (people, places, shows), spelled exactly as the story spells them.
- "scenes" splits the story where its own breaks fall (horizontal rules, time jumps, location changes), in order. "firstWords" are the first six or more words of the scene, copied exactly, so the scene can be found in the text.
- "music" is one line describing instrumental music for the scene's mood: instruments, tempo, feeling. Never ask for vocals.`;

export const SCENE_INSTRUCTION = `You turn one scene of an author's story into the notation for an audio drama. Return only the notation for this scene, without its heading or music block.

Notation:
- A line of dialogue: **NAME** *(cue)*: words
- Narration: a paragraph that starts with its cue: *(cue)* words
- A silence: a fenced block with the language pause and a duration such as 1.5s, on its own lines.
- A comment no one hears: <!-- ... -->

Rules:
1. Keep every sentence of the author's text, in order, word for word. Do not reword, summarize, or fix the author's writing.
2. Split the author's paragraphs into narration and dialogue lines. A new speaker always starts a new paragraph.
3. Drop speech tags such as "I said" or "she asked" only when the speaker is clear from the voice. Keep any action in the tag as narration or as part of the cue.
4. Every line and every narration paragraph gets a cue. The cue says how the words feel, written with the line just before it in mind: (stung, quieter), (barely holding it together), (fighting a smile). Never describe an action in a cue, such as (typing fast) or (calling from down the hall): the voice reads actions aloud.
5. Add a pause only where the text names a silence ("For a moment, the world stopped") or after a big emotional beat.
6. When the text describes background speech vividly or for a laugh, you may dramatize it as one short line by a minor character. Put <!-- director: added --> on the line before it, and replace the sentence that described it with <!-- replaced: "the exact sentence" -->, so it is shown once, not told and then shown. Never invent other lines.
7. Use only the cast ids you are given. Text messages are read by the character who sent them.

Example (author's text, then notation):

Author: "You're negotiating with a vending machine again?" I turned. June Park stood behind me, holding two chocolate milks.

**JUNE** *(amused)*: You're negotiating with a vending machine again?

*(caught out, a little sheepish)* I turned. June Park stood behind me, holding two chocolate milks.`;

export const REPAIR_INSTRUCTION = `${SCENE_INSTRUCTION}

You are fixing a scene you already wrote. You get the author's text for the scene, your current notation, and a list of problems. Return the whole corrected scene. Fix every problem and change nothing else.`;
