export interface AudioPlacement {id:string;narrationId:string;title:string;startSeconds:number;inSeconds:number;outSeconds:number;volume:number;muted:boolean}
export function readAudioPlacements(value:unknown):AudioPlacement[]{
 if(!Array.isArray(value))return [];
 return value.slice(0,32).flatMap(v=>{
  if(!v||typeof v!=='object'||typeof v.id!=='string'||typeof v.narrationId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(v.narrationId)||![v.startSeconds,v.inSeconds,v.outSeconds,v.volume].every(Number.isFinite)||v.startSeconds<0||v.startSeconds>300||v.inSeconds<0||v.outSeconds-v.inSeconds<0.05||v.outSeconds>36000||v.volume<0||v.volume>1)return [];
  return [{id:v.id,narrationId:v.narrationId,title:typeof v.title==='string'?v.title.slice(0,200):'Narration',startSeconds:v.startSeconds,inSeconds:v.inSeconds,outSeconds:v.outSeconds,volume:v.volume,muted:v.muted===true}];
 });
}
