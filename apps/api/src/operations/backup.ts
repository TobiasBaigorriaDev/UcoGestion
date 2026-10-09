import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

export const retentionDays = 35;
const header = Buffer.from('UCOBACK1');
export const manifestSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), createdAt: z.iso.datetime(),
  keyReference: z.string().min(1), databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.strictObject({ name: z.enum(['database.enc','custody.enc']), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).length(2) });
export type BackupManifest = z.infer<typeof manifestSchema>;

export function validateBackupTarget(target: { primaryAccount: string; backupAccount: string; bucket: string; keyReference: string }): void {
  if (!target.primaryAccount || !target.backupAccount || target.primaryAccount === target.backupAccount) throw new Error('Backup must use an independent account.');
  if (!target.bucket || !target.keyReference) throw new Error('Backup bucket and independent key reference are required.');
}

export async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function sealFile(source: string, destination: string, key: Uint8Array): Promise<void> {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(header);
  const handle = await open(destination,'wx',0o600);
  try {
    await handle.write(Buffer.concat([header,iv]));
    await pipeline(createReadStream(source),cipher,createWriteStream(destination,{fd:handle.fd,start:20,autoClose:false}));
    const size = (await handle.stat()).size;
    await handle.write(cipher.getAuthTag(),0,16,size);
  } finally { await handle.close(); }
}

export async function openFile(source: string, destination: string, key: Uint8Array): Promise<void> {
  // A failed authentication never leaves plaintext at the restore destination.
  const temporary = `${destination}.${randomUUID()}.partial`;
  const handle = await open(source,'r');
  try {
    const size = (await handle.stat()).size;
    if (size < 36) throw new Error('Invalid encrypted backup.');
    const prefix = Buffer.alloc(20), tag = Buffer.alloc(16);
    await handle.read(prefix,0,20,0); await handle.read(tag,0,16,size-16);
    if (!prefix.subarray(0,8).equals(header)) throw new Error('Invalid encrypted backup version.');
    const decipher = createDecipheriv('aes-256-gcm',key,prefix.subarray(8));
    decipher.setAAD(header); decipher.setAuthTag(tag);
    await pipeline(createReadStream(source,{start:20,end:size-17}),decipher,createWriteStream(temporary,{flags:'wx',mode:0o600}));
    const { rename } = await import('node:fs/promises');
    await rename(temporary,destination);
  } catch (error) { await rm(temporary,{force:true}); await rm(destination,{force:true}); throw error; }
  finally { await handle.close(); }
}

export interface BackupStore {
  put(name: string, path: string): Promise<void>;
  get(name: string, path: string): Promise<void>;
}

export async function publishBackup(directory: string, dump: string, custody: unknown, key: Uint8Array,
  keyReference: string, createdAt: string, store: BackupStore): Promise<BackupManifest> {
  const id = randomUUID();
  const databaseSha256 = await checksum(dump);
  const custodyFile = join(directory,'custody.json');
  await writeFile(custodyFile,JSON.stringify({ databaseSha256, createdAt, id, environment:custody }),{mode:0o600,flag:'wx'});
  try {
    await sealFile(dump,join(directory,'database.enc'),key);
    await sealFile(custodyFile,join(directory,'custody.enc'),key);
    const files: BackupManifest['files'] = [];
    for (const name of ['database.enc','custody.enc'] as const) {
      const path = join(directory,name);
      files.push({name,sha256:await checksum(path)});
      await store.put(`${id}/${name}`,path);
    }
    const manifest = manifestSchema.parse({version:1,id,createdAt,keyReference,databaseSha256,files});
    const manifestPath = join(directory,'manifest.json');
    await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
    // Commit marker last. Partial uploads are never selectable as successful backups.
    await store.put(`${id}/manifest.json`,manifestPath);
    return manifest;
  } finally { await rm(custodyFile,{force:true}); }
}

export async function downloadBackup(directory: string, id: string, key: Uint8Array, store: BackupStore) {
  z.uuid().parse(id);
  const manifestPath = join(directory,'manifest.json');
  await store.get(`${id}/manifest.json`,manifestPath);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));
  if (manifest.id !== id || new Set(manifest.files.map(file => file.name)).size !== 2) throw new Error('Invalid backup identity.');
  for (const file of manifest.files) {
    const path = join(directory,file.name);
    await store.get(`${id}/${file.name}`,path);
    if (await checksum(path) !== file.sha256) throw new Error('Backup checksum mismatch.');
    await openFile(path,join(directory,file.name === 'database.enc' ? 'database.dump' : 'custody.json'),key);
  }
  const custody = z.object({id:z.uuid(),createdAt:z.string(),databaseSha256:z.string(),environment:z.record(z.string(),z.string())})
    .parse(JSON.parse(await readFile(join(directory,'custody.json'),'utf8')));
  if (custody.id !== id || custody.createdAt !== manifest.createdAt || custody.databaseSha256 !== manifest.databaseSha256 ||
    await checksum(join(directory,'database.dump')) !== custody.databaseSha256) throw new Error('Backup authentication mismatch.');
  if ((await stat(join(directory,'database.dump'))).size === 0) throw new Error('Empty database backup.');
  return { manifest, environment:custody.environment };
}
