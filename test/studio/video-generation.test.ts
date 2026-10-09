import { describe, expect, it } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import { createSceneDraft } from '../../studio/src/lib/scene-direction';
import { parseVideoRequest, readVideoForm, MAX_VIDEO_REQUEST_BYTES, type VideoJob } from '../../studio/src/lib/video-generation';
import { runVideoJob } from '../../studio/src/lib/video-job-runner';
import { planSceneGeneration } from '../../studio/src/lib/scene-generation-plan';

const id = `v_${'a'.repeat(32)}`;
const png = () => new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])], 'frame.png', { type: 'image/png' });
const mp4 = new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]);
function form(mode: 'text' | 'image' | 'references' = 'text') {
  const data = new FormData();
  data.set('id', id); data.set('draft', JSON.stringify({ ...createSceneDraft(), mode }));
  return data;
}

describe('video submission', () => {
  it('serializes timed beats and continuity as visible direction', async () => {
    const data = form();
    const draft = { ...createSceneDraft(), note: 'One continuous shot, with no cuts.' };
    data.set('draft', JSON.stringify(draft));
    const request = await parseVideoRequest(data);
    expect(request.prompt).toContain('[0–3s] Glide');
    expect(request.prompt).toContain(draft.note);
    expect(request.references).toHaveLength(0);
  });

  it('numbers image roles in their actual attachment order', async () => {
    const data = form('references');
    data.set('firstFrame', png()); data.append('reference', png()); data.append('reference', png());
    const request = await parseVideoRequest(data);
    expect(request.prompt).toContain('<FIRST_FRAME>@Image1');
    expect(request.prompt).toContain('<IMAGE_REF_0>@Image2 <IMAGE_REF_1>@Image3');
  });

  it('rejects missing mode inputs, fake images, invalid ids and oversized direction', async () => {
    await expect(parseVideoRequest(form('image'))).rejects.toThrow('first frame');
    await expect(parseVideoRequest(form('references'))).rejects.toThrow('reference image');
    const fake = form('image'); fake.set('firstFrame', new File(['not an image'], 'fake.png', { type: 'image/png' }));
    await expect(parseVideoRequest(fake)).rejects.toThrow('valid PNG');
    const invalid = form(); invalid.set('id', '../other-user');
    await expect(parseVideoRequest(invalid)).rejects.toThrow('invalid');
    const oversized = form(); const draft = createSceneDraft(); draft.beats[0].text = 'x'.repeat(20001); oversized.set('draft', JSON.stringify(draft));
    await expect(parseVideoRequest(oversized)).rejects.toThrow('20,000');
    const many = form('references'); for (let index = 0; index < 7; index++) many.append('reference', png());
    await expect(parseVideoRequest(many)).rejects.toThrow('six');
  });

  it('caps a streamed upload even without a content-length header', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(MAX_VIDEO_REQUEST_BYTES + 1)); }, cancel() { cancelled = true; } });
    const request = new Request('http://localhost/api/videos', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readVideoForm(request)).rejects.toThrow('32 MB');
    expect(cancelled).toBe(true);
  });
});

describe('video job execution', () => {
  it('resumes a saved opening without generating or replacing it again', async () => {
    const data = form(); const draft = createSceneDraft(); draft.beats[1].end = 18;
    data.set('draft', JSON.stringify(draft));
    const request = await parseVideoRequest(data);
    request.resume = { interactionId: 'saved-opening', durationSeconds: 10.006 };
    let calls = 0; let saves = 0; const patches: Partial<VideoJob>[] = [];
    await runVideoJob(request, {
      provider: { async generateVideoClip(_prompt, options) {
        calls++;
        expect(options?.previousInteractionId).toBe('saved-opening');
        expect(options?.durationSeconds).toBe(8);
        expect(options?.task).toBeUndefined();
        return { interactionId: 'continued', videoBytes: mp4, durationSeconds: 18.006 };
      } },
      save: async () => { saves++; }, update: async patch => { patches.push(patch); },
    });
    expect(calls).toBe(1); expect(saves).toBe(1);
    expect(patches.at(-1)).toMatchObject({ status: 'ready', durationSeconds: 18.006 });
  });

  it('automatically extends an 18-second scene and sends only the remaining beats', async () => {
    const data = form(); const draft = createSceneDraft();
    draft.beats.push({ id: 'reveal', text: 'Reveal the dog.', start: 6, end: 12 }, { id: 'sit', text: 'The dog sits.', start: 12, end: 18 });
    data.set('draft', JSON.stringify(draft));
    const calls: Array<{prompt: string; options: Record<string, unknown>}> = [];
    const saved: number[] = []; const patches: Partial<VideoJob>[] = [];
    await runVideoJob(await parseVideoRequest(data), {
      provider: { async generateVideoClip(prompt, options) { calls.push({prompt,options:options as unknown as Record<string, unknown>});return { interactionId: `turn-${calls.length}`, videoBytes: mp4, durationSeconds: calls.length === 1 ? 10 : 18 }; } },
      save: async () => { saved.push(calls.length); }, update: async patch => { patches.push(patch); },
    });
    expect(calls).toHaveLength(2); expect(calls[0].options.durationSeconds).toBe(10);
    expect(calls[0].prompt).not.toContain('The dog sits.');
    expect(calls[1].options).toMatchObject({ durationSeconds: 8, previousInteractionId: 'turn-1' });
    expect(calls[1].options.task).toBeUndefined();
    expect(calls[1].prompt).toContain('[0–2s] Reveal the dog.');
    expect(calls[1].prompt).toContain('[2–8s] The dog sits.');
    expect(calls[1].prompt).not.toContain('Glide through');
    expect(saved).toEqual([1,2]);
    expect(patches.at(-1)).toMatchObject({ status: 'ready', durationSeconds: 18 });
  });

  it('keeps the opening clip as a partial result if extension fails or returns only a short tail', async () => {
    for (const fails of [true,false]) {
      const data = form(); const draft = createSceneDraft(); draft.beats[1].end=18;data.set('draft',JSON.stringify(draft));
      let calls=0;let saves=0; const patches: Partial<VideoJob>[]=[];
      await runVideoJob(await parseVideoRequest(data), {
        provider: { async generateVideoClip() { calls++;if(calls===2&&fails)throw new Error('429 quota exhausted');return {interactionId:`turn-${calls}`,videoBytes:mp4,durationSeconds:calls===1?10:8}; } },
        save: async()=>{saves++;}, update: async patch=>{patches.push(patch);},
      });
      expect(saves).toBe(1);expect(patches.at(-1)).toMatchObject({status:'partial',durationSeconds:10});
      expect(patches.at(-1)?.message).toContain('18s requested');
    }
  });

  it('plans valid per-turn lengths and rejects unsupported scenes', () => {
    for (const seconds of [3,6,11,12,18,21,40]) {
      const draft=createSceneDraft();draft.beats=[{id:'one',text:'Action',start:0,end:seconds}];
      const plan=planSceneGeneration(draft);
      expect(plan.reduce((total,step)=>total+step.durationSeconds,0)).toBe(seconds);
      expect(plan.every(step=>step.durationSeconds>=3&&step.durationSeconds<=10)).toBe(true);
    }
    const draft=createSceneDraft();draft.beats[1].end=41;
    expect(()=>planSceneGeneration(draft)).toThrow('40 seconds');
  });
  it('requests the duration implied by the last timed beat', async () => {
    const request = await parseVideoRequest(form());
    let optionsSeen: Record<string, unknown> | undefined;
    await runVideoJob(request, {
      provider: { async generateVideoClip(_prompt, options) { optionsSeen = options as unknown as Record<string, unknown>; return { interactionId: 'duration', videoBytes: new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]) }; } },
      update: async () => {}, save: async () => {},
    });
    expect(optionsSeen?.durationSeconds).toBe(6);
  });

  it('owns temporary inputs and marks ready only after the MP4 has been saved', async () => {
    const data = form('references'); data.set('firstFrame', png()); data.append('reference', png());
    const request = await parseVideoRequest(data);
    const patches: Partial<VideoJob>[] = [];
    let inputPath = ''; let saved = false;
    const mp4 = new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]);
    await runVideoJob(request, {
      provider: { async generateVideoClip(prompt, options) {
        expect(prompt).toContain('<FIRST_FRAME>@Image1');
        expect(options?.task).toBe('image_to_video'); expect(options?.aspectRatio).toBe('16:9');
        inputPath = options!.firstFrame!;
        expect((await readFile(inputPath))[0]).toBe(137);
        return { interactionId: 'interaction', videoBytes: mp4 };
      } },
      update: async patch => { if (patch.status === 'ready') expect(saved).toBe(true); patches.push(patch); },
      save: async bytes => { expect(bytes).toEqual(mp4); saved = true; },
    });
    expect(patches.map(patch => patch.status)).toEqual(['saving', 'ready']);
    await expect(access(inputPath)).rejects.toThrow();
  });

  it('records quota errors and never labels invalid output as ready', async () => {
    for (const quota of [false, true]) {
      const patches: Partial<VideoJob>[] = []; let saved = false;
      await runVideoJob(await parseVideoRequest(form()), {
        provider: { async generateVideoClip() { if (quota) throw new Error('429 quota exhausted'); return { interactionId: 'empty', videoBytes: new Uint8Array() }; } },
        update: async patch => { patches.push(patch); }, save: async () => { saved = true; },
      });
      expect(saved).toBe(false); expect(patches.at(-1)?.status).toBe('error');
      if (quota) expect(patches.at(-1)?.message).toContain('quota');
    }
  });
});
