// Isolated hook harness: execute the real provider's effects with controlled SDK delivery.
import {mock} from 'bun:test';
import {createRequire} from 'node:module';
const studioRequire=createRequire(new URL('../../../studio/package.json',import.meta.url));
mock.module(studioRequire.resolve('react/jsx-dev-runtime'),()=>({jsxDEV:()=>null}));
mock.module(studioRequire.resolve('react/jsx-runtime'),()=>({jsx:()=>null,jsxs:()=>null}));
const effects: (()=>unknown)[]=[];
const states: unknown[]=[];
let reloads=0;
const pending: ((value:string)=>void)[]=[];
const storage=new Map<string,string>();
const currentUser={uid:'owner',email:'owner@example.test',displayName:'Owner',photoURL:''};
mock.module(studioRequire.resolve('react'),()=>({
 createContext:()=>({Provider:()=>null}),useContext:()=>null,
 useState:(initial:unknown)=>{const index=states.length;states.push(initial);return [initial,(next:unknown)=>{states[index]=next;}];},
 useRef:(value:unknown)=>({current:value}),useMemo:(fn:()=>unknown)=>fn(),useCallback:(fn:unknown)=>fn,
 useEffect:(fn:()=>unknown)=>effects.push(fn),
}));
mock.module(new URL('../../../studio/node_modules/firebase/auth/dist/index.mjs',import.meta.url).pathname,()=>({GoogleAuthProvider:class{},onAuthStateChanged:(_auth:unknown,callback:(user:unknown)=>void)=>{queueMicrotask(()=>callback(currentUser));return ()=>{};},signOut:async()=>{},signInWithPopup:async()=>{}}));
mock.module(new URL('../../../studio/node_modules/firebase/firestore/dist/index.mjs',import.meta.url).pathname,()=>({onSnapshot:(_ref:unknown,next:(value:unknown)=>void)=>{queueMicrotask(()=>next({exists:()=>false}));return ()=>{};}}));
mock.module('../../../studio/src/lib/firebase',()=>({auth:()=>({currentUser})}));
mock.module('../../../studio/src/lib/connectivity',()=>({useConnectivity:()=> 'online'}));
mock.module('../../../studio/src/lib/users',()=>({
 checkEmailAllowlist:()=>new Promise<string>(resolve=>pending.push(resolve)),upsertUserProfile:async()=>{},userRef:()=>({}),toUserProfile:()=>null,saveProfileFields:async()=>{},saveSettings:async()=>{},
}));
Object.assign(globalThis,{window:{setTimeout:()=>0,clearTimeout:()=>{},addEventListener:()=>{},removeEventListener:()=>{},location:{reload:()=>{reloads++;}},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}}});
const {AuthProvider}=await import('../../../studio/src/lib/auth-context');
AuthProvider({children:null});
const cleanups=effects.map(effect=>effect());
await new Promise(resolve=>setTimeout(resolve,0));
// Connectivity's recheck answers before the initial auth/allowlist callback.
pending[0]!('allowed');await new Promise(resolve=>setTimeout(resolve,0));
const startupReloads=reloads;
for(const resolve of pending.slice(1))resolve('allowed');
await new Promise(resolve=>setTimeout(resolve,0));
console.log(JSON.stringify({startupReloads,loading:states[2],user:!!states[0]}));
for(const cleanup of cleanups)if(typeof cleanup==='function')cleanup();
if(startupReloads!==0||states[2]!==false||!states[0])process.exit(1);
