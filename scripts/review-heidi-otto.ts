/** User-authorized provider review of this generated proof only. */
import {readFile,writeFile} from 'node:fs/promises';
import {createGeminiClient} from '../src/tts/gemini-client-factory';
const [input,output,model="gemini-3.5-flash-lite"]=process.argv.slice(2);if(!input||!output)throw Error('Supply video input and review output.');
const result=await createGeminiClient().models.generateContent({model,contents:[{role:'user',parts:[{inlineData:{mimeType:'video/mp4',data:(await readFile(input)).toString('base64')},videoMetadata:{fps:6}},{text:`Critically inspect the ENTIRE attached video and listen to ALL its audio. Return JSON, no praise. This is a continuity and dialogue acceptance review, not an aesthetic compliment. Report observations even when they conflict with the intended script. Do not hallucinate words from the expected lines; transcribe what you actually hear first. Split transcript into individual utterances with precise intervals. Watch mouths during each interval: if no visible dog speaks and the track is voiceover, report that as a speaker error and FAIL; do not pass silently. If words differ, list that mismatch explicitly. A pass must agree with your reported defects.
Fields:
actualTranscript: array of {startSeconds,endSeconds,words,voiceDescription,visibleSpeakingDog,confidence};
castTimeline: array of {startSeconds,endSeconds,visibleFigures};
humansOrExtraAnimals: array of timestamped defects (including background and reflections);
speakerErrors: array of timestamped defects;
physicalDefects: array of timestamped anatomy, contact, intersections, morphing, teleportation;
continuityDefects: array including any internal cut, jump, repeated action, identity/room change or voice shift;
pacing: concrete description of delivery, pauses, dead time, abrupt boundaries;
uncertainties: what you cannot establish reliably;
pass: boolean; reasons: array.
Intended visual: exactly TWO long-haired tricolor Bernese Mountain Dogs. Heidi LEFT, visibly elderly silver muzzle burgundy collar, lying on cushion. Otto RIGHT, stocky ochre collar, seated. No humans anywhere. Camera fixed; no cut. Only modest head and eye movement, paws grounded, muddy prints static. NO TOOLS or manipulated props.
Expected dialogue: Heidi alone says "Otto. You were meant to clear the path." and (only if the clip extends beyond seven seconds) "Not bring it in. Breakfast is waiting." Otto is silent throughout; his mouth should not act out speech. Both lines same low older female voice. Flag repetition, wrong words, unexpected narrator, male voice, speaker swaps. Distinguish breathing from speaking. A technically valid video can still FAIL.`}]}],config:{responseMimeType:'application/json',abortSignal:AbortSignal.timeout(120000)}});
await writeFile(output,result.text??'{}');console.log(result.text);
