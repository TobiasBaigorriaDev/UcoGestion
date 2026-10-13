import { readFileSync, openSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const environment = { ...process.env, NODE_ENV: 'development' };
for (const line of readFileSync(new URL('.env.local', import.meta.url), 'utf8').split('\n')) {
 if (!line) continue; const split=line.indexOf('='); environment[line.slice(0,split)]=JSON.parse(line.slice(split+1));
}
const processes = [];
async function responds(url) {
 try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; }
 catch { return false; }
}
const apiReady = await responds('http://localhost:4000/api/v1/health/ready');
const webReady = await responds('http://localhost:3000/login');
const services = [];
if (!apiReady) services.push(['api', ['apps/api/dist/main.js'], root]);
if (!webReady) services.push(['web', [require.resolve('next/dist/bin/next'), 'dev', '--hostname', 'localhost', '--port', '3000'], fileURLToPath(new URL('../../apps/web/', import.meta.url))]);
for (const [name, args, cwd] of services) {
 const output=openSync(new URL(name+'.log', import.meta.url),'a');
 const child=spawn(process.execPath,args,{cwd,env:environment,detached:true,windowsHide:true,stdio:['ignore',output,output]});
 child.unref(); processes.push({name,pid:child.pid});
}
if (processes.length) writeFileSync(new URL('processes.json',import.meta.url),JSON.stringify(processes,null,2));
console.log(processes.length ? `Servicios iniciados: ${processes.map(item=>item.name).join(', ')}. Abrir http://localhost:3000/login` : 'La API y la web ya están activos: http://localhost:3000/login');
