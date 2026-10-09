import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, PutBucketLifecycleConfigurationCommand, S3Client } from '@aws-sdk/client-s3';
import type { BackupStore } from './backup.js';
import { retentionDays, validateBackupTarget } from './backup.js';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required configuration: ${name}`);
  return value;
}

/** Separate credentials/account from operational object storage. Never creates buckets. */
export class IndependentBackupStore implements BackupStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor() {
    this.bucket = required('BACKUP_BUCKET');
    validateBackupTarget({primaryAccount:required('PRIMARY_ACCOUNT_ID'),backupAccount:required('BACKUP_ACCOUNT_ID'),
      bucket:this.bucket,keyReference:required('BACKUP_KEY_REFERENCE')});
    this.client = new S3Client({endpoint:required('BACKUP_ENDPOINT'),region:required('BACKUP_REGION'),forcePathStyle:true,
      credentials:{accessKeyId:required('BACKUP_ACCESS_KEY_ID'),secretAccessKey:required('BACKUP_SECRET_ACCESS_KEY')}});
  }
  async configureRetention(): Promise<void> {
    await this.client.send(new PutBucketLifecycleConfigurationCommand({Bucket:this.bucket,LifecycleConfiguration:{Rules:[
      {ID:'uco-daily-35-days',Status:'Enabled',Filter:{Prefix:'uconext/'},Expiration:{Days:retentionDays},
        NoncurrentVersionExpiration:{NoncurrentDays:retentionDays},AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}},
    ]}}));
  }
  async put(name: string, path: string): Promise<void> {
    await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:`uconext/${name}`,Body:createReadStream(path),IfNoneMatch:'*',ContentType:'application/octet-stream'}));
  }
  async get(name: string, path: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:`uconext/${name}`}));
    if (!response.Body) throw new Error('Backup object unavailable.');
    await pipeline(response.Body.transformToWebStream(),createWriteStream(path,{flags:'wx',mode:0o600}));
  }
  async latestId(): Promise<string> {
    let token: string | undefined, latest: {id:string;date:Date} | undefined;
    do {
      const page=await this.client.send(new ListObjectsV2Command({Bucket:this.bucket,Prefix:'uconext/',ContinuationToken:token}));
      for(const object of page.Contents ?? []) {
        const match=object.Key?.match(/^uconext\/([a-f0-9-]{36})\/manifest\.json$/);
        if(match?.[1] && object.LastModified && (!latest || object.LastModified>latest.date)) latest={id:match[1],date:object.LastModified};
      }
      token=page.IsTruncated ? page.NextContinuationToken : undefined;
    } while(token);
    if(!latest)throw new Error('No committed backup available.');
    return latest.id;
  }
}
