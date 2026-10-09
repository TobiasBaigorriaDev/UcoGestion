import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sealFile, openFile, publishBackup, downloadBackup, validateBackupTarget, retentionDays } from '../src/operations/backup.js';

it('T231 authenticates encrypted backup bytes and detects tampering before restoring', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uco-backup-'));
  try {
    const source = join(dir,'dump'), sealed = join(dir,'encrypted'), restored = join(dir,'restored');
    const bytes = randomBytes(8192), key = randomBytes(32);
    await writeFile(source, bytes);
    await sealFile(source,sealed,key);
    expect(await readFile(sealed)).not.toEqual(bytes);
    await openFile(sealed,restored,key);
    expect(await readFile(restored)).toEqual(bytes);
    const corrupt = await readFile(sealed); corrupt[30] = (corrupt[30] ?? 0) ^ 1;
    await writeFile(sealed,corrupt);
    await expect(openFile(sealed,restored,key)).rejects.toThrow();
    await expect(readFile(restored)).rejects.toThrow();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

it('T231 requires an independent backup account and fixes retention at 35 days', () => {
  expect(retentionDays).toBe(35);
  expect(() => validateBackupTarget({ primaryAccount:'primary', backupAccount:'primary', bucket:'backups', keyReference:'vault/backup/v1' })).toThrow(/independent/);
  expect(() => validateBackupTarget({ primaryAccount:'primary', backupAccount:'secondary', bucket:'backups', keyReference:'vault/backup/v1' })).not.toThrow();
});

it('T231 publishes its commit marker last and verifies checksums on download', async () => {
  const directory = await mkdtemp(join(tmpdir(),'uco-publication-'));
  const restore = await mkdtemp(join(tmpdir(),'uco-download-'));
  const objects = new Map<string,Buffer>();
  const store = {put:async (name:string,path:string) => {objects.set(name,await readFile(path));},
    get:async (name:string,path:string) => { const bytes=objects.get(name); if (!bytes) throw new Error('missing'); await writeFile(path,bytes); }};
  try {
    const key=randomBytes(32), dump=join(directory,'dump');
    await writeFile(dump,randomBytes(1000));
    const manifest=await publishBackup(directory,dump,{OFFLINE_ACK_SIGNING_KEYS:'{}'},key,'vault/key/v1',new Date().toISOString(),store);
    expect([...objects.keys()].at(-1)).toBe(`${manifest.id}/manifest.json`);
    expect((await downloadBackup(restore,manifest.id,key,store)).environment).toEqual({OFFLINE_ACK_SIGNING_KEYS:'{}'});
    expect(await readFile(join(restore,'database.dump'))).toEqual(await readFile(dump));
    objects.set(`${manifest.id}/database.enc`,Buffer.from('corrupt'));
    await expect(downloadBackup(restore,manifest.id,key,store)).rejects.toThrow(/checksum/);
  } finally { await rm(directory,{recursive:true,force:true}); await rm(restore,{recursive:true,force:true}); }
});
