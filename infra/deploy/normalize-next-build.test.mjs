import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeNextBuild } from './normalize-next-build.mjs';

test('normalizes unused Next cryptographic metadata consistently and refuses Server Actions', async () => {
  const directories=[];
  try {
    for(const salt of ['a','b']) {
      const directory=await mkdtemp(join(tmpdir(),'uco-next-'));directories.push(directory);
      await mkdir(join(directory,'server'));
      const preview={previewModeId:salt.repeat(32),previewModeSigningKey:salt.repeat(64),previewModeEncryptionKey:salt.toUpperCase().repeat(64)};
      const references={node:{},edge:{},encryptionKey:Buffer.alloc(32,salt.charCodeAt(0)).toString('base64')};
      await writeFile(join(directory,'prerender-manifest.json'),JSON.stringify({preview}));
      await writeFile(join(directory,'server/middleware-manifest.json'),JSON.stringify({env:preview}));
      await writeFile(join(directory,'server/server-reference-manifest.json'),JSON.stringify(references));
      await writeFile(join(directory,'server/server-reference-manifest.js'),`self.__RSC_SERVER_MANIFEST=${JSON.stringify(JSON.stringify(references))}`);
      await normalizeNextBuild(directory,Buffer.alloc(32,7),'revision');
    }
    for(const file of ['prerender-manifest.json','server/middleware-manifest.json','server/server-reference-manifest.json','server/server-reference-manifest.js']) {
      assert.equal(await readFile(join(directories[0],file),'utf8'),await readFile(join(directories[1],file),'utf8'));
    }
    await writeFile(join(directories[0],'server/server-reference-manifest.json'),JSON.stringify({node:{action:{}},edge:{},encryptionKey:'unused'}));
    await assert.rejects(normalizeNextBuild(directories[0],Buffer.alloc(32,7),'revision'),/Server Actions/);
  } finally {for(const directory of directories)await rm(directory,{recursive:true,force:true});}
});
