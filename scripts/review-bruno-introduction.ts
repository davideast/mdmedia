/** Production review of the authorized Bruno greeting and its edit. */
import {readFile,writeFile} from 'node:fs/promises';
import {createGeminiClient} from '../src/tts/gemini-client-factory';

const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Supply video input and JSON review output.');
const prompt=`Watch the entire attached video WITH AUDIO. Report observations, not reassurance. First transcribe what you actually hear, then compare to the intended scene. This contains two shots. The first approximately 10 seconds is an opening ALREADY ACCEPTED by the filmmaker. Do not re-grade its aesthetic quality or minor articulation; use it as the continuity anchor. The NEW shot after the cut should contain one actual Bernese Mountain Dog, Bruno, a navy collar, a broad white chest, in the same warm wooden room's doorway. Heidi and Otto should be outside that tighter frame. Bruno looks toward offscreen Heidi and alone says: "Morning, Grandmother." Adult warm male baritone, visibly originating at his canine mouth. No reply. No humans or extra animals in the new shot. No floating paws, furniture changes, morphing, or interacting with props. Allow modest head/muzzle movement. The hard cut is intended; a new room, dog identity shift or unexplained character replacement is not. Compare woodwork, lighting, doorway geography and eyeline across the cut. If this is the final edit (about 12.25 seconds), it deliberately crops Bruno to face and chest and starts his sound 0.5 seconds BEFORE the visual cut: that short audio prelap is intentional, not a speaker error. Assess only what is visible and audible in the attached edit. Do not infer unseen legs or require the window to appear in an angle looking toward the doorway. Flag any genuinely conflicting architecture, unexplained replacement, confusing eyeline, truncated words or broken visible motion.
Report JSON fields:
actualTranscript: [{startSeconds,endSeconds,words,voiceDescription,visibleSpeaker,confidence}];
newShotStartSeconds: number;
newShotVisibleCast: string;
humansOrExtraAnimals: timestamped defects;
speakerErrors: timestamped errors or uncertainty;
physicalDefects: timestamped defects in new shot;
continuityAcrossCut: concrete description and any material mismatch;
newShotFirstHalfSecondAudio: actual sounds heard, and whether any greeting syllable occurs there;
safeAudioPrelapSeconds: number between 0 and 0.6, only if those first seconds contain pawsteps/collar noise without speech and can play before the visual cut;
pacing: delivery, unnecessary pauses, clipped words and cut timing;
uncertainties: array;
newShotAcceptable: boolean;
reasons: array.
Do not equate limited talking-animal articulation to a total failure if Bruno clearly owns the line; do flag voiceover with a completely still closed mouth, mismatched/wrong speaker, missing or repeated dialogue, humans, duplicate dogs or obvious broken physical motion. Be specific when uncertain.`;
const result=await createGeminiClient().models.generateContent({
  model:'gemini-3.1-pro-preview',
  contents:[{role:'user',parts:[
    {inlineData:{mimeType:'video/mp4',data:(await readFile(input)).toString('base64')},videoMetadata:{fps:6}},
    {text:prompt},
  ]}],
  config:{responseMimeType:'application/json',abortSignal:AbortSignal.timeout(120000)},
});
await writeFile(output,result.text??'{}');
console.log(result.text);
