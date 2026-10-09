import {expect,it} from 'bun:test';
import {resolve} from 'node:path';
it('lets initial authentication finish without a concurrent connectivity reload',async()=>{
 const root=resolve(import.meta.dir,'../..');
 const process=Bun.spawn([Bun.which('bun')!,'--tsconfig-override',resolve(root,'studio/tsconfig.json'),resolve(import.meta.dir,'fixtures/auth-startup.ts')],{cwd:root,stdout:'pipe',stderr:'pipe'});
 const [output,error,exit]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);
 expect({exit,output:output.trim(),...(exit?{error}:{})}).toEqual({exit:0,output:'{"startupReloads":0,"loading":false,"user":true}'});
});
