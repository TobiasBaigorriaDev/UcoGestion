import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Next emits random preview/action metadata even when neither feature is used.
 * Keep consistent private metadata for the same release without patching Next or its crypto runtime.
 */
export async function normalizeNextBuild(directory, seed, revision) {
  if(seed.length!==32 || !revision)throw new Error('A 32-byte build custody key and revision are required.');
  const preview=JSON.parse(await readFile(join(directory,'prerender-manifest.json'),'utf8')).preview;
  const references=JSON.parse(await readFile(join(directory,'server/server-reference-manifest.json'),'utf8'));
  if(Object.keys(references.node).length || Object.keys(references.edge).length)throw new Error('Server Actions require a separate approved build design.');
  const derive=purpose=>createHmac('sha256',seed).update(`${revision}:${purpose}`).digest();
  const replacements=[
    [preview.previewModeId,derive('preview-id').subarray(0,16).toString('hex')],
    [preview.previewModeSigningKey,derive('preview-signing').toString('hex')],
    [preview.previewModeEncryptionKey,derive('preview-encryption').toString('hex')],
    [references.encryptionKey,derive('unused-actions').toString('base64')],
  ];
  if(replacements.some(([source])=>typeof source!=='string'||source.length<16))throw new Error('Unexpected Next build metadata layout.');
  replacements.sort(([left],[right])=>right.length-left.length);
  for(const file of ['prerender-manifest.json','server/middleware-manifest.json','server/server-reference-manifest.json','server/server-reference-manifest.js']) {
    const path=join(directory,file);
    let content=await readFile(path,'utf8');
    for(const [source,destination] of replacements)content=content.split(source).join(destination);
    await writeFile(path,content);
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const seed=Buffer.from((await readFile('/run/secrets/web-build-key','utf8')).trim(),'base64');
  try {
    await normalizeNextBuild('apps/web/.next',seed,process.env.UCONEXT_BUILD_ID);
    await normalizeNextBuild('apps/web/.next/standalone/apps/web/.next',seed,process.env.UCONEXT_BUILD_ID);
  }
  finally {seed.fill(0);}
}
