import { createServer } from 'node:http';

export function workerIsReady(lastCycleAt: number, now = Date.now()): boolean {
  return lastCycleAt > 0 && now-lastCycleAt < 60000;
}
export function startWorkerHealth(port = 3001) {
  let lastCycleAt=0;
  const server=createServer((request,response)=>{
    const live=request.url==='/health/live';
    const ready=request.url==='/health/ready' && workerIsReady(lastCycleAt);
    response.writeHead(live || ready ? 200 : 503,{'Content-Type':'application/json'});
    response.end(JSON.stringify({status:live?'live':ready?'ready':'unavailable'}));
  });
  server.listen(port,'0.0.0.0');
  return {recordCycle:()=>{lastCycleAt=Date.now();},close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
