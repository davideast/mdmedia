import {readFile,writeFile} from 'node:fs/promises';
const d='.design/beneath-double-coat/breakfast-exchange';
const sadie=`${d}/sadie-rosemary-performance.mp4`;
const bruno=`${d}/bruno-bella-performance.mp4`;
const f=(frames:number)=>frames/24;
const newCuts=[
 {file:sadie,start:0,end:f(45),label:'Continue accepted Sadie close-up: And rosemary.'},
 {file:bruno,start:f(9),end:f(54),label:'Bruno, same established reverse angle: Sadie...'},
 {file:sadie,start:f(61),end:f(91),label:'Sadie identifies Bella by name.'},
 {file:bruno,start:f(112),end:f(132),label:'Silent Bruno reaction compresses the long pause before Your ex.'},
 {file:sadie,start:f(130),end:f(163),label:'Return to same Sadie performance: Your ex.'},
 {file:bruno,start:f(62),end:f(126),label:'Same Bruno performance: She offered me a snack.'},
 {file:sadie,start:f(167),end:f(221),label:'Same Sadie performance: And you stayed until midnight?'},
 {file:bruno,start:f(139),end:f(222),label:'Same Bruno performance: It was very good cheese. Hold his guilty glance.'},
 {file:`${d}/breakfast-establish.mp4`,start:f(9),end:f(69),label:'Return to the established wide two-shot; untouched cheddar remains between them.'},
];
const accepted=JSON.parse(await readFile(`${d}/edit-exposition.json`,'utf8'));
await writeFile(`${d}/edit-bella-complete.json`,JSON.stringify([...accepted,...newCuts],null,2));
await writeFile(`${d}/edit-bella-context.json`,JSON.stringify([...accepted.slice(5),...newCuts],null,2));
console.log('Prepared full edit and breakfast-context review edit.');
