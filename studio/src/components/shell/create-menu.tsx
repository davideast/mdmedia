"use client";
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Plus,AudioLines,Film} from 'lucide-react';
import {Popover,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
import {Button} from '@/components/ui/button';
export function CreateMenu({compact=false}:{compact?:boolean}){
 const router=useRouter();const [open,setOpen]=useState(false);
 return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline" size={compact?'icon-sm':'sm'} aria-label="Create media" className={compact?'':'w-full justify-start'}><Plus size={15}/>{compact?null:'Create'}</Button></PopoverTrigger><PopoverContent align="start" className="w-64 p-2"><p className="px-2 py-2 text-sm font-medium">Create</p>{[{name:'Narration',href:'/studio',Icon:AudioLines,hint:'Markdown to speech'},{name:'Video',href:'/studio/scene',Icon:Film,hint:'Direct and assemble a video'}].map(({name,href,Icon,hint})=><button key={name} className="flex w-full items-center gap-3 rounded p-3 text-left hover:bg-secondary" onClick={()=>{setOpen(false);router.push(`${href}?draft=${crypto.randomUUID()}`);}}><Icon size={17}/><span><span className="block text-sm">{name}</span><span className="text-xs text-ink-muted">{hint}</span></span></button>)}<p className="border-t border-border px-2 pt-3 text-xs text-ink-muted">Music and sound-effect generation are coming next.</p></PopoverContent></Popover>;
}
