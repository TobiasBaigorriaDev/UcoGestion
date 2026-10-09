import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const revision = process.env.SOURCE_REVISION ?? execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const epoch = process.env.SOURCE_DATE_EPOCH ?? execFileSync('git',['show','-s','--format=%ct','HEAD'],{encoding:'utf8'}).trim();
const origin=process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname) && !process.env.WEB_BUILD_KEY)throw new Error('Production requires WEB_BUILD_KEY from build secret custody.');
const directory=mkdtempSync(join(tmpdir(),'uco-build-')),secret=join(directory,'web-build-key');
const material=process.env.WEB_BUILD_KEY ?? createHash('sha256').update('uconext-local-build-only').digest('base64');
if(Buffer.from(material,'base64').length!==32)throw new Error('WEB_BUILD_KEY must contain 32 bytes encoded as base64.');
writeFileSync(secret,material,{mode:0o600});
try {
execFileSync(process.execPath,['--test','infra/deploy/normalize-next-build.test.mjs'],{stdio:'inherit'});
for (const target of ['api','worker','web']) {
  const args=['buildx','build','--platform','linux/amd64','--provenance=false','--output','type=docker,rewrite-timestamp=true,unpack=false','-f','infra/deploy/Dockerfile',
    '--target',target,'--build-arg',`SOURCE_REVISION=${revision}`,'--build-arg',`SOURCE_DATE_EPOCH=${epoch}`,
    '--build-arg',`NEXT_PUBLIC_WEB_ORIGIN=${origin}`,'--build-arg',`WEB_BUILD_KEY_FINGERPRINT=${createHash('sha256').update(material).digest('hex')}`,
    '--secret',`id=web-build-key,src=${secret}`,
    '-t',`uconext-${target}:operations`,'.'];
  execFileSync('docker',args,{stdio:'inherit'});
  if (process.argv.includes('--verify')) {
    const repeated=[...args];
    repeated[repeated.indexOf(`uconext-${target}:operations`)]=`uconext-${target}:reproduced`;
    repeated.splice(repeated.length-1,0,'--no-cache-filter',target==='web'?'web-build':'api-build');
    execFileSync('docker',repeated,{stdio:'inherit'});
    const digest=tag=>execFileSync('docker',['image','inspect',tag,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
    const original=digest(`uconext-${target}:operations`),duplicate=digest(`uconext-${target}:reproduced`);
    if(original!==duplicate)throw new Error(`${target} image is not reproducible: ${original} != ${duplicate}`);
    process.stdout.write(`${target}: independently compiled image matches ${original}\n`);
  }
}
} finally {rmSync(directory,{recursive:true,force:true});}
