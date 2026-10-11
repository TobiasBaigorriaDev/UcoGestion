import { readFileSync, openSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
let alreadyRunning=false;
try {
 const ready=await fetch('http://localhost:3000/api/v1/health/ready',{signal:AbortSignal.timeout(1500)});
 if(ready.ok) { console.log('Los servicios ya están activos: http://localhost:3000/login'); alreadyRunning=true; }
} catch { /* Start services when the local environment is stopped. */ }
if(!alreadyRunning) {
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const environment = { ...process.env, NODE_ENV: 'development' };
for (const line of readFileSync(new URL('.env.local', import.meta.url), 'utf8').split('\n')) {
 if (!line) continue; const split=line.indexOf('='); environment[line.slice(0,split)]=JSON.parse(line.slice(split+1));
}
const processes = [];
for (const [name, args, cwd] of [
 ['api', ['apps/api/dist/main.js'], root],
 ['web', [require.resolve('next/dist/bin/next'), 'dev', '--hostname', 'localhost', '--port', '3000'], fileURLToPath(new URL('../../apps/web/', import.meta.url))],
]) {
 const output=openSync(new URL(name+'.log', import.meta.url),'a');
 const child=spawn(process.execPath,args,{cwd,env:environment,detached:true,windowsHide:true,stdio:['ignore',output,output]});
 child.unref(); processes.push({name,pid:child.pid});
}
writeFileSync(new URL('processes.json',import.meta.url),JSON.stringify(processes,null,2));
console.log('Servicios iniciados. Abrir http://localhost:3000/login');
}
