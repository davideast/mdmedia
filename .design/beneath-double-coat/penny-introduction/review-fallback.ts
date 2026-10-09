import {readFile,writeFile} from 'node:fs/promises';
import {createGeminiClient} from '../../../src/tts/gemini-client-factory';
const [input,expectations,output]=process.argv.slice(2);
const context=await readFile(expectations,'utf8');
const result=await createGeminiClient().models.generateContent({
 model:'gemini-3.5-flash-lite',
 contents:[{role:'user',parts:[
  {inlineData:{mimeType:'video/mp4',data:(await readFile(input)).toString('base64')},videoMetadata:{fps:4}},
  {text:`Watch the ENTIRE attached video and listen to ALL audio. First transcribe what is actually audible with start/end timestamps, voice description and visible speaking character; do not manufacture words from the intended script. Then critically assess the supplied production requirements. Distinguish normal camera framing changes from actual identity or set changes. State uncertainty when anatomy or ownership cannot be established. Natural talking-dog articulation may be approximate, but do flag a voiceover with no jaw movement, the wrong dog speaking, added or missing dialogue, humans, extra animals, obvious broken motion, abrupt audio clipping, or continuity contradictions. Assess the actual rendered video, not hypothetical prompt risks.\n\n${context}\n\nReturn JSON with actualTranscript:[{startSeconds,endSeconds,words,voice,visibleSpeaker,confidence}], castByShot:[{startSeconds,endSeconds,characters}], continuityFindings:[], speakerErrors:[], unwantedFigures:[], physicalDefects:[], pacingAndAudio:[], materialFailures:[], uncertainties:[], acceptable:boolean. Each issue needs a timestamp and a concrete observation. Do not claim exact verification where evidence is limited.`}
 ]}],config:{responseMimeType:'application/json',abortSignal:AbortSignal.timeout(180000)}
});
await writeFile(output,result.text??'{}');console.log(result.text);
