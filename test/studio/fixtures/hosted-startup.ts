// Exercise the installed, patched Pyric caller and transport with a stalled first socket.
import {readFileSync} from 'node:fs';
import {rawRpc} from '../../../studio/node_modules/@pyric/cli/dist/serve/worker/client/core.js';
import {getHostedFirestore} from '../../../studio/node_modules/@pyric/cli/dist/serve/worker/client/websocket-connection.js';
const runtime=readFileSync(new URL('../../../studio/node_modules/@pyric/cli/dist/serve/entries/worker-runtime.js',import.meta.url),'utf8');
const fn=runtime.slice(runtime.indexOf('function hostedTarget()'),runtime.indexOf('export const WORKER_URL'));
const target=new Function('payload','location','toPageOriginWsUrl','initPayload',`${fn};return hostedTarget();`)({bridgeUrl:'ws://localhost:3473/__pyric/sandbox',projectKey:'test'},{},(url:string)=>url,Promise.resolve({}));
const timers=new Map<number,{fn:()=>void,ms:number}>();let timerId=0;const errors:string[]=[];let connected=false,attempts=0;
Object.assign(globalThis,{setTimeout:(fn:()=>void,ms:number)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:(id:number)=>timers.delete(id)});
class Socket extends EventTarget {static OPEN=1;readyState=0;constructor(_url:string){super();attempts++;if(attempts>1)queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}close(){this.readyState=3;}send(raw:string){const m=JSON.parse(raw);if(m.type==='attach')queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'attach-ack',protocol:1,bridgeVersion:'test',peerConnected:true,clientSessionId:'test',projectKey:'test',capabilities:['worker-port']})})));else if(m.type==='worker-message'&&typeof m.message.id==='string')queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'worker-message-result',message:{t:'res',id:m.message.id,ok:true,value:'delivered'}})})));}}
Object.assign(globalThis,{WebSocket:Socket});
const db=getHostedFirestore({...target,onError:(e:Error)=>errors.push(e.message)});
const request=rawRpc(db.port,{t:'op',id:'unsent-request',method:'getDoc',path:'test/doc'}).catch(error=>'rejected: '+error.message);
db.port.observeConnection((value:boolean)=>connected=value);
function tick(){const next=[...timers.entries()].sort((a,b)=>a[1].ms-b[1].ms)[0];if(next){timers.delete(next[0]);next[1].fn();}}
tick(); await Promise.resolve();tick();await Promise.resolve();await Promise.resolve();await Promise.resolve();
const delivered=await request;const pass=connected&&errors.length===0&&delivered==='delivered';console.log(JSON.stringify({attempts,connected,errors,delivered}));db.port.close();
if(!pass)process.exit(1);
