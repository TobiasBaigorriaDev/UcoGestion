import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('./storage-runtime/package.json', import.meta.url));
const S3rver = require('s3rver');
const Account = require('s3rver/lib/models/account');
Account.DUMMY_ACCOUNT.createKeyPair('uconext_development', 'uconext_development');
const directory = fileURLToPath(new URL('./storage-data/', import.meta.url));
mkdirSync(directory, { recursive: true });
const server = new S3rver({ address: '127.0.0.1', port: 9000, directory, silent: true,
  allowMismatchedSignatures: false, vhostBuckets: false });
await server.run();
console.log('Local S3 storage ready on 127.0.0.1:9000');
