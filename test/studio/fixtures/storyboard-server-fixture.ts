import { mock } from 'bun:test';
import assert from 'node:assert/strict';
type Data = Record<string, unknown>;
type Sortable = string | number;
const documents = new Map<string, Data>();
const files = new Map<string, Buffer>();
let sequence = 0;
let transactionTail = Promise.resolve();
class Ref {
  constructor(readonly path: string) {}
  get id() { return this.path.split('/').at(-1)!; }
  async get() { const data = documents.get(this.path); return { ref: this, id: this.id, exists: !!data, data: () => data ? structuredClone(data) : undefined }; }
  async set(data: Data) { documents.set(this.path, structuredClone(data)); }
  async update(patch: Data) { assert(documents.has(this.path), `Missing ${this.path}`); documents.set(this.path, { ...documents.get(this.path), ...structuredClone(patch) }); }
  async delete() { documents.delete(this.path); }
}
interface Transaction { get(ref: Ref): ReturnType<Ref['get']>; set(ref: Ref, data: Data): void; update(ref: Ref, data: Data): void; delete(ref: Ref): void }
/** Collections at any depth: `productions/{id}/cuts` lists only that production's cuts. */
class Query {
  constructor(readonly collection: string, readonly filters: Array<[string, string, unknown]> = [], readonly orders: Array<[string, string]> = [], readonly cap = Infinity) {}
  doc(id = `auto${++sequence}`) { return new Ref(`${this.collection}/${id}`); }
  where(field: string, op: string, value: unknown) { return new Query(this.collection, [...this.filters, [field, op, value]], this.orders, this.cap); }
  orderBy(field: string, direction = 'asc') { return new Query(this.collection, this.filters, [...this.orders, [field, direction]], this.cap); }
  limit(cap: number) { return new Query(this.collection, this.filters, this.orders, cap); }
  async get() {
    const depth = this.collection.split('/').length + 1;
    let entries = [...documents.entries()].filter(([path]) => path.startsWith(`${this.collection}/`) && path.split('/').length === depth);
    entries = entries.filter(([, data]) => this.filters.every(([field, op, expected]) => op === '==' && data[field] === expected));
    for (const [field, direction] of [...this.orders].reverse()) entries.sort((a, b) => { const x = a[1][field] as Sortable; const y = b[1][field] as Sortable; return (x < y ? -1 : x > y ? 1 : 0) * (direction === 'desc' ? -1 : 1); });
    return { empty: entries.length === 0, docs: entries.slice(0, this.cap).map(([path]) => { const ref = new Ref(path); return { id: ref.id, ref, data: () => structuredClone(documents.get(path)) }; }) };
  }
}
const db = { collection: (name: string) => new Query(name), async runTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
  const previous = transactionTail; let release!: () => void; transactionTail = new Promise(resolve => { release = resolve; }); await previous;
  const writes: (() => Promise<void>)[] = []; let writing = false;
  const write = (step: () => Promise<void>) => { writing = true; writes.push(step); };
  try {
    const result = await run({
      get: (ref: Ref) => { assert(!writing, 'Read after write in transaction'); return ref.get(); },
      set: (ref: Ref, data: Data) => write(() => ref.set(data)),
      update: (ref: Ref, data: Data) => write(() => ref.update(data)),
      delete: (ref: Ref) => write(() => ref.delete()),
    });
    for (const step of writes) await step();
    return result;
  } finally { release(); }
} };

mock.module('../../../studio/src/lib/firebase-admin', () => ({ adminDb: () => db, isAllowlisted: async () => true,
  verifyUser: async (header: string) => header === 'Bearer owner' ? { uid: 'owner', email: 'owner@example.test' } : header === 'Bearer other' ? { uid: 'other', email: 'other@example.test' } : null }));
const {generateApiKey} = await import('../../../studio/src/lib/api-key-token');
const keys = {read:generateApiKey(),write:generateApiKey(),production:generateApiKey()};
const scopes = {read:['storyboards:read'],write:['storyboards:read','storyboards:write'],production:['productions:read','productions:write']};
for(const [name,key] of Object.entries(keys)) documents.set(`apiKeys/${key.keyId}`,{ownerUid:'owner',ownerEmail:'owner@example.test',hash:key.hash,scopes:scopes[name as keyof typeof scopes],revokedAt:null,lastUsedAt:Date.now()});
const list = await import('../../../studio/src/app/api/v1/storyboards/route');
const one = await import('../../../studio/src/app/api/v1/storyboards/[id]/route');
const request=(method:string,token:string,body?:unknown)=>new Request('http://studio.test/api/v1/storyboards',{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const params=(id:string)=>({params:Promise.resolve({id})});
assert.equal((await list.GET(request('GET','missing'))).status,401);
assert.equal((await list.POST(request('POST',keys.read.token,{title:'No'}))).status,403);
assert.equal((await list.GET(request('GET',keys.production.token))).status,403);
assert.equal((await list.POST(request('POST','owner',{title:'   '}))).status,400);
assert.equal((await list.POST(request('POST',keys.write.token,{title:'Invalid document',document:null}))).status,400);
assert.equal((await (await list.GET(request('GET',keys.read.token))).json()).storyboards.length,0);
const response=await list.POST(request('POST',keys.write.token,{title:'Independent story'}));
assert.equal(response.status,201);const created=await response.json();
assert.equal([...documents.keys()].some(path=>path.startsWith('productions/')),false);
assert.equal(created.storyboard.revision,1);assert.equal(created.title,'Independent story');
const id=created.id;
assert.equal((await one.GET(request('GET','other'),params(id))).status,404);
assert.equal((await one.PUT(request('PUT','other',{expectedRevision:1,document:created.storyboard.document}),params(id))).status,404);
assert.equal((await one.DELETE(request('DELETE','other'),params(id))).status,404);
assert.equal((await (await list.GET(request('GET','other'))).json()).storyboards.length,0);
const doc={...created.storyboard.document,beats:[{id:'a',title:'A beat',purpose:'',script:'Hello',visual:'',notes:'',status:'draft',estimatedSeconds:null}]};
const save=(expectedRevision:number,title='New title')=>one.PUT(request('PUT',keys.write.token,{expectedRevision,title,document:doc}),params(id));
const results=await Promise.all([save(1),save(1)]);
assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
const saved=await (await one.GET(request('GET',keys.read.token),params(id))).json();
assert.equal(saved.title,'New title');assert.deepEqual(saved.storyboard.document,doc);assert.equal(saved.storyboard.revision,2);
const summaries=await (await list.GET(request('GET',keys.read.token))).json();assert.equal(summaries.storyboards[0].beatCount,1);assert.equal(summaries.storyboards[0].document,undefined);
assert.equal((await one.PUT(request('PUT','owner',{expectedRevision:2,document:{...doc,beats:[doc.beats[0],doc.beats[0]]}}),params(id))).status,400);
documents.set('productions/unrelated',{ownerUid:'owner',title:'Production',cuts:[]});
assert.equal((await one.DELETE(request('DELETE',keys.write.token),params(id))).status,204);
assert.equal((await one.GET(request('GET',keys.read.token),params(id))).status,404);
assert(documents.has('productions/unrelated'));
console.log('PASS: independent CRUD, owner isolation, dedicated scopes, summaries, title/content CAS, no production coupling');

if (process.argv.includes('--cli')) {
  // Real route handlers and API-key verification; only Firestore is in-memory.
  // Options are a fixed reader catalogue. No synthesis endpoint is installed.
  const other = generateApiKey();
  documents.set(`apiKeys/${other.keyId}`, {ownerUid:'other',ownerEmail:'other@example.test',hash:other.hash,scopes:['storyboards:read','storyboards:write'],revokedAt:null,lastUsedAt:Date.now()});
  const options = {voices:{gemini:[{id:'Kore',name:'Kore'}],elevenlabs:[]},models:['gemini-2.5-flash-preview-tts'],presets:{delivery:[]},defaults:{voice:{provider:'gemini',id:'Kore',name:'Kore'},model:'gemini-2.5-flash-preview-tts',delivery:'Read naturally.',speed:1}};
  let unexpectedRequests = 0;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const route = new URL(req.url).pathname;
    if(route === '/api/v1/storyboards') {
      if(req.method==='GET') return list.GET(req);
      if(req.method==='POST') return list.POST(req);
    }
    const match = /^\/api\/v1\/storyboards\/([^/]+)$/.exec(route);
    if(match) {
      const context=params(decodeURIComponent(match[1]!));
      if(req.method==='GET') return one.GET(req,context);
      if(req.method==='PUT') return one.PUT(req,context);
      if(req.method==='DELETE') return one.DELETE(req,context);
    }
    if(req.method==='GET') {
      if(route==='/api/v1/options') return Response.json(options);
      if(route==='/api/v1/narrations') return Response.json({narrations:[]});
      if(route==='/api/v1/productions') return Response.json({productions:[]});
    }
    unexpectedRequests++;
    return Response.json({error:{code:'unexpected_test_request',message:`Unexpected ${req.method} ${route}`}}, {status:500});
  }});
  try {
    const child=Bun.spawn([process.execPath,'test','test/e2e/studio-storyboard.test.ts'],{env:{...process.env,STORYBOARD_E2E_URL:server.url.origin,STORYBOARD_E2E_KEY:keys.write.token,STORYBOARD_E2E_READ_KEY:keys.read.token,STORYBOARD_E2E_OTHER_KEY:other.token,STORYBOARD_E2E_PAID:'0',STORYBOARD_E2E_BUILT:''},stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    assert.equal(code,0,stdout+'\n'+stderr);
    assert.equal(unexpectedRequests,0,'Dry-run and invalid flags must never reach synthesis');
    console.log('PASS: automatic CLI HTTP suite');
  } finally {server.stop(true);}
}
