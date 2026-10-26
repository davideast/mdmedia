import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const records = new Map<string, any>();
let starts = 0;
let queue = Promise.resolve();
const db = {
  collection: () => ({ doc: (id: string) => ({ id, delete: async () => { records.delete(id); } }) }),
  runTransaction: async (fn: any) => {
    const result = queue.then(() => fn({
      get: async (ref: any) => ({ exists: records.has(ref.id), data: () => records.get(ref.id) }),
      set: (ref: any, value: any) => records.set(ref.id, value),
    }));
    queue = result.then(() => undefined, () => undefined); return result;
  },
};
// Resolve from the route so both root-only CI installs and Studio installs mock
// the same Next.js module that the handler actually imports.
const routeRequire = createRequire(new URL('../../../studio/src/app/api/v1/storyboards/[id]/narration/route.ts', import.meta.url));
mock.module(routeRequire.resolve('next/server'), () => ({ after: (fn: any) => void fn() }));
mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db }));
mock.module('../../../studio/src/lib/api-auth', () => ({
  authorize: async (request: Request) => request.headers.get('authorization') ? { uid: 'owner', scopes: ['storyboards:read'] } : new Response(null, {status: 401}),
  hasScope: () => true, forbiddenScope: () => new Response(null, {status:403}),
  readJsonObject: (request: Request) => request.json(),
  apiError: (status: number, code: string, message: string) => Response.json({error:{code,message}},{status}),
}));
mock.module('../../../studio/src/lib/storyboard-server', () => ({ noStore: {'Cache-Control':'no-store'}, storyboardApi: (fn: any) => fn(), getStoryboard: async (_uid: string, id: string) => { if(id!=='owned') throw Error('not owner'); return {}; } }));
mock.module('../../../studio/src/lib/narration-start', () => ({ startNarration: async ({request}: any) => {
  starts++;
  records.set(request.id, {...records.get(request.id),status:'ready'});
  return {ok:true,id:request.id,stream:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'meta',id:request.id})+'\n'));controller.close();}})};
} }));
const {POST} = await import('../../../studio/src/app/api/v1/storyboards/[id]/narration/route');
const body={markdown:'Read these exact words.',voice:'Kore',voiceProvider:'gemini',voiceId:'Kore',speed:1};
const call=(patch={},auth=true,id='owned')=>POST(new Request('http://localhost/test',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{authorization:'test'}:{})},body:JSON.stringify({...body,...patch})}),{params:Promise.resolve({id})});
assert.equal((await call({},false)).status,401);
assert.equal(starts,0);
await assert.rejects(call({},true,'someone-elses-production'));
assert.equal(starts,0);
assert.equal((await call({markdown:''})).status,400);
const results=await Promise.all([call(),call()]);
assert.equal(starts,1);
const ids=await Promise.all(results.map(async r=>(await r.json()).id));assert.equal(ids[0],ids[1]);
await call();assert.equal(starts,1);
await call({voice:'Puck',voiceId:'Puck'});assert.equal(starts,2);
await call({markdown:'Changed words.'});assert.equal(starts,3);
await call({speed:1.25});assert.equal(starts,4);
records.set(ids[0],{...records.get(ids[0]),status:'error'});
assert.equal((await call()).status,409);assert.equal(starts,4);
console.log('PASS: auth, ownership, invalid text, concurrent reuse, voice/text/pace changes, no automatic failed retry');
