import {expect,it} from 'bun:test';
import {resolve} from 'node:path';
it('recovers a stalled first hosted connection without rejecting unsent requests',async()=>{
 const child=Bun.spawn([Bun.which('bun')!,resolve(import.meta.dir,'fixtures/hosted-startup.ts')],{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({exit,result:stdout.trim(),...(exit?{stderr}:{})}).toEqual({exit:0,result:'{"attempts":2,"connected":true,"errors":[],"delivered":"delivered"}'});
});
