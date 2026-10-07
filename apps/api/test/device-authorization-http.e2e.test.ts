import { createCipheriv, createHash, createPublicKey, publicEncrypt, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';

import { offlineGrantProofPayload } from '@uconext/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { canonicalEnvelopeJson } from '../src/modules/offline-sync/historical-envelope-validator.js';
import { verifyOfflineAck } from '../src/modules/offline-sync/offline-ack.js';
import { deliveryProofPayload } from '../src/modules/offline-sync/offline-delivery.service.js';
import { configureApi } from '../src/configure-api.js';
import { runMigrations } from '../src/database/migrate.js';
import { createGlobalUser } from '../src/modules/auth/global-user.repository.js';
import { DeviceCertificate } from '../src/modules/offline-sync/device-certificate.js';

describe('T185 POS device HTTP authorization', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousCertificateKey = process.env.DEVICE_CERTIFICATE_KEY;
  const previousSigningKey = process.env.OFFLINE_SIGNING_PRIVATE_KEY;
  const previousSigningId = process.env.OFFLINE_SIGNING_KEY_ID;
  const previousIngestionKeys = process.env.OFFLINE_INGESTION_KEYS;
  const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const branchId = randomUUID();
  const foreignBranchId = randomUUID();
  const email = 'device-http-owner@example.com';
  const secret = randomBytes(32);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const owner = await createGlobalUser(pool, { email, password: 'correct-password' });
    await pool.query("INSERT INTO organizations (id, base_currency, timezone) VALUES ($1, 'ARS', 'UTC'), ($2, 'ARS', 'UTC')",
      [organizationId, foreignOrganizationId]);
    await pool.query("INSERT INTO branches (id, organization_id, name) VALUES ($1, $2, 'Own'), ($3, $4, 'Foreign')",
      [branchId, organizationId, foreignBranchId, foreignOrganizationId]);
    await pool.query("INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), organizationId, owner.id]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DEVICE_CERTIFICATE_KEY = secret.toString('base64url');
    process.env.OFFLINE_SIGNING_PRIVATE_KEY = signer.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    process.env.OFFLINE_SIGNING_KEY_ID = 'test-trusted';
    const ingestion = generateKeyPairSync('rsa', { modulusLength: 3072 });
    process.env.OFFLINE_INGESTION_KEYS = JSON.stringify({ activeKeyId: 'test-ingestion', keys: {
      'test-ingestion': ingestion.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    } });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApi(module.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close(); await pool?.end(); await container?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousCertificateKey === undefined) delete process.env.DEVICE_CERTIFICATE_KEY;
    else process.env.DEVICE_CERTIFICATE_KEY = previousCertificateKey;
    if (previousSigningKey === undefined) delete process.env.OFFLINE_SIGNING_PRIVATE_KEY;
    else process.env.OFFLINE_SIGNING_PRIVATE_KEY = previousSigningKey;
    if (previousSigningId === undefined) delete process.env.OFFLINE_SIGNING_KEY_ID;
    else process.env.OFFLINE_SIGNING_KEY_ID = previousSigningId;
    if (previousIngestionKeys === undefined) delete process.env.OFFLINE_INGESTION_KEYS;
    else process.env.OFFLINE_INGESTION_KEYS = previousIngestionKeys;
  });

  it('requires session/CSRF and returns an idempotent certificate for a same-tenant branch', async () => {
    const publicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000').send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const post = (branch: string, idempotencyKey: string) => request(app.getHttpServer())
      .post('/api/v1/devices/authorize-pos').set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', idempotencyKey)
      .send({ branchId: branch, publicKey });
    await request(app.getHttpServer()).post('/api/v1/devices/authorize-pos')
      .set('Origin', 'http://localhost:3000').send({ branchId, publicKey }).expect(401);
    const first = await post(branchId, 'device-http-1').expect(201);
    expect(new DeviceCertificate(secret).open(first.body.certificate as string))
      .toMatchObject({ organizationId, deviceId: first.body.id });
    expect((await post(branchId, 'device-http-1').expect(201)).body).toEqual(first.body);
    const forbidden = await post(foreignBranchId, 'device-http-2').expect(409);
    expect(forbidden.body).toMatchObject({ code: 'DEVICE_BRANCH_NOT_AVAILABLE' });
    expect((await pool.query('SELECT count(*)::integer AS total FROM devices WHERE public_key = $1', [publicKey]))
      .rows[0]?.total).toBe(1);
  });

  it('T186 exposes a signed bootstrap only through session, CSRF and authorized device scope', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000').send({ email, password: 'correct-password' }).expect(204);
    const cookie = (login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const device = (await pool.query('SELECT id FROM devices WHERE organization_id = $1 LIMIT 1', [organizationId])).rows[0]?.id as string;
    const post = (body: object, key: string) => request(app.getHttpServer()).post('/api/v1/offline/bootstrap')
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', key).send(body);
    const first = await post({ deviceId: device, branchId }, 'bootstrap-http').expect(201);
    expect(verify('sha256', Buffer.from(first.body.payload as string), signer.publicKey,
      Buffer.from(first.body.signature as string, 'base64'))).toBe(true);
    expect(first.headers['cache-control']).toBe('no-store');
    expect((await post({ deviceId: device, branchId }, 'bootstrap-http').expect(201)).body).toEqual(first.body);
    await post({ deviceId: device, branchId: foreignBranchId }, 'bootstrap-foreign').expect(403);
    await post({ deviceId: device, branchId, clients: [] }, 'bootstrap-invalid').expect(400);
    await request(app.getHttpServer()).post('/api/v1/offline/bootstrap').set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie).set('X-Organization-Id', organizationId).send({ deviceId: device, branchId }).expect(403);
    const previous = process.env.OFFLINE_INGESTION_KEYS;
    delete process.env.OFFLINE_INGESTION_KEYS;
    try {
      const unavailable = await post({ deviceId: device, branchId }, 'bootstrap-no-keys').expect(503);
      expect(unavailable.body).toMatchObject({ code: 'OFFLINE_KEYS_UNAVAILABLE' });
    } finally { process.env.OFFLINE_INGESTION_KEYS = previous; }
  });

  it('T187 requires a completed signed checkpoint and login alone never changes the grant deadline', async () => {
    const login = async () => {
      const result = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000')
        .send({ email, password: 'correct-password' }).expect(204);
      return (result.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    };
    const cookie = await login();
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie', cookie).expect(200);
    const device = (await pool.query('SELECT id FROM devices WHERE organization_id = $1 LIMIT 1', [organizationId])).rows[0]?.id as string;
    const post = (route: string, body: object, key: string) => request(app.getHttpServer()).post(`/api/v1/offline/${route}`)
      .set('Origin', 'http://localhost:3000').set('Cookie', cookie).set('X-Organization-Id', organizationId)
      .set('X-CSRF-Token', csrf.body.csrfToken as string).set('Idempotency-Key', key).send(body);
    const bootstrap = await post('bootstrap', { deviceId: device, branchId }, 'grant-http-bootstrap').expect(201);
    const proofInput = { grantId: JSON.parse(bootstrap.body.payload as string).grantId as string,
      bootstrapHash: createHash('sha256').update(bootstrap.body.payload as string).digest('hex'), deviceSequence: '0', headHash: null };
    const proof = sign('sha256', Buffer.from(offlineGrantProofPayload(proofInput)),
      { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const issued = await post('authorize', { ...proofInput, proof }, 'grant-http').expect(201);
    const before = (await pool.query('SELECT expires_at FROM offline_grants WHERE id = $1', [proofInput.grantId])).rows[0]?.expires_at as Date;
    await login();
    expect((await post('authorize', { ...proofInput, proof }, 'grant-http-retry').expect(201)).body).toEqual(issued.body);
    await post('authorize', { ...proofInput, proof: 'invalid' }, 'grant-http-failed').expect(403);
    expect((await pool.query('SELECT expires_at FROM offline_grants WHERE id = $1', [proofInput.grantId])).rows[0]?.expires_at).toEqual(before);
  });
  it('T201A permits only possession-proved opaque delivery, consumes nonces once and bounds input', async () => {
    const keyPair = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const deviceId = randomUUID();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const certificates = new DeviceCertificate(secret);
    const actor = (await pool.query('SELECT id FROM users WHERE email_normalized=$1', [email])).rows[0]?.id as string;
    await pool.query(`INSERT INTO devices (id,organization_id,branch_id,authorized_by_user_id,authorized_at,status,public_key,public_key_thumbprint)
      VALUES ($1,$2,$3,$4,now(),'REVOKED',$5,$6)`, [deviceId,organizationId,branchId,actor,publicKey,certificates.thumbprint(publicKey)]);
    const certificate = certificates.issue({ deviceId, organizationId, thumbprint: certificates.thumbprint(publicKey) });
    const post = (route: string, body: object) => request(app.getHttpServer()).post(`/api/v1/offline/delivery/${route}`)
      .set('Origin','http://localhost:3000').send(body);
    const response = await post('challenge', { certificate }).expect(200);
    const challenge = response.body.challenge as string;
    expect(typeof challenge).toBe('string');
    const claims = JSON.parse(Buffer.from(challenge.split('.')[1] ?? '', 'base64url').toString());
    expect(claims).not.toHaveProperty('organizationId');
    const ciphertext = randomBytes(32);
    const envelopes = [JSON.stringify({version:1,keyId:'test-ingestion',operationId:randomUUID(),certificate,
      iv:randomBytes(12).toString('base64'),wrappedCek:randomBytes(384).toString('base64'),ciphertext:ciphertext.toString('base64'),
      ciphertextHash:createHash('sha256').update(ciphertext).digest('base64'),signature:randomBytes(64).toString('base64')})];
    const proof = sign('sha256', Buffer.from(deliveryProofPayload(challenge, envelopes)),
      { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    // Unauthenticated envelope ciphertext has no business effects or definitive ACK.
    await post('push', { certificate, challenge, envelopes, proof }).expect(503);
    const replay = await post('push', { certificate, challenge, envelopes, proof }).expect(403);
    const forged = await post('push', { certificate: 'v1.invalid', challenge, envelopes, proof }).expect(403);
    expect(replay.body.code).toBe(forged.body.code);
    const next = (await post('challenge', { certificate }).expect(200)).body.challenge as string;
    const changedProof = sign('sha256',Buffer.from(deliveryProofPayload(next,envelopes)),
      {key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    await post('push', {certificate,challenge:next,envelopes:envelopes.map(value => `${value} `),proof:changedProof}).expect(403);
    await post('push', {certificate,challenge:`${next}x`,envelopes,proof:changedProof}).expect(403);
    const largeCiphertext=randomBytes(110000);
    const largeEnvelopes=[JSON.stringify({...JSON.parse(envelopes[0] ?? '{}'),ciphertext:largeCiphertext.toString('base64'),
      ciphertextHash:createHash('sha256').update(largeCiphertext).digest('base64')})];
    const largeProof=sign('sha256',Buffer.from(deliveryProofPayload(next,largeEnvelopes)),
      {key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    await post('push',{certificate,challenge:next,envelopes:largeEnvelopes,proof:largeProof}).expect(503);
    await post('push', { certificate, challenge: next, envelopes: ['changed-bytes'], proof }).expect(403);
    await post('push', { certificate, challenge: next, envelopes: Array.from({length:51}, () => 'opaque'), proof }).expect(403);
    await request(app.getHttpServer()).post('/api/v1/offline/delivery/challenge').set('Origin','https://wrong.example').send({certificate}).expect(403);
    await request(app.getHttpServer()).post('/api/v1/offline/delivery/challenge').set('Origin','http://localhost:3000').set('Content-Type','text/plain').send('invalid').expect(415);
    const expired = {...claims,jti:randomUUID(),iat:Math.floor(Date.now()/1000)-121,exp:Math.floor(Date.now()/1000)-1};
    const expiredHeader = Buffer.from(JSON.stringify({alg:'ES256',kid:'test-trusted',typ:'uco-delivery-challenge+jwt'})).toString('base64url');
    const expiredBody = Buffer.from(JSON.stringify(expired)).toString('base64url');
    const expiredChallenge = `${expiredHeader}.${expiredBody}.${sign('sha256',Buffer.from(`${expiredHeader}.${expiredBody}`),
      {key:signer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
    await pool.query(`INSERT INTO sync_delivery_challenges (organization_id,device_id,jti_hash,certificate_hash,origin,expires_at)
      VALUES ($1,$2,$3,$4,$5,to_timestamp($6))`, [organizationId,deviceId,createHash('sha256').update(expired.jti).digest('hex'),expired.certificateHash,expired.origin,expired.exp]);
    const expiredProof = sign('sha256',Buffer.from(deliveryProofPayload(expiredChallenge,envelopes)),
      {key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    await post('push',{certificate,challenge:expiredChallenge,envelopes,proof:expiredProof}).expect(403);
    await expect(pool.query('UPDATE sync_delivery_challenges SET used_at=NULL WHERE used_at IS NOT NULL')).rejects.toThrow('already consumed');
    const statuses:number[]=[];
    for (let attempt=0;attempt<21;attempt+=1) statuses.push((await post('challenge',{certificate})).status);
    expect(statuses).toContain(403);
  });

  it('T201B denies ordinary reads/writes and discordant tenant headers to a delivery certificate', async () => {
    const device = (await pool.query('SELECT id, public_key_thumbprint FROM devices WHERE organization_id=$1 LIMIT 1', [organizationId])).rows[0];
    const certificate = new DeviceCertificate(secret).issue({ organizationId, deviceId: device.id, thumbprint: device.public_key_thumbprint });
    for (const path of ['/catalog/items', `/sales/${randomUUID()}/receipt`, `/sales/${randomUUID()}`, '/offline/status', '/reports/sales', '/sales/checkout-context']) {
      const response = await request(app.getHttpServer()).get(`/api/v1${path}`)
        .set('Authorization', `Bearer ${certificate}`).set('X-Organization-Id', organizationId);
      expect([401,404]).toContain(response.status);
    }
    for (const path of ['/sales', '/cash-sessions/open', '/catalog/items', '/offline/bootstrap', '/inventory/adjustments']) {
      const response = await request(app.getHttpServer()).post(`/api/v1${path}`)
        .set('Origin','http://localhost:3000').set('Authorization', `Bearer ${certificate}`)
        .set('X-Organization-Id', foreignOrganizationId).send({certificate});
      expect([401,403,404]).toContain(response.status);
    }
    await request(app.getHttpServer()).post('/api/v1/offline/delivery/challenge')
      .set('Origin','http://localhost:3000').set('X-Organization-Id',foreignOrganizationId).send({certificate}).expect(403);
  });


  it('T208A exposes idempotent D01 barriers and requires every signed grant checkpoint before completion',async()=>{
    const login=await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin','http://localhost:3000').send({email,password:'correct-password'}).expect(204);
    const cookie=(login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf=await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie',cookie).expect(200);
    const post=(path:string,body:object,key:string)=>request(app.getHttpServer()).post(`/api/v1/offline/configuration-barriers${path}`)
      .set('Origin','http://localhost:3000').set('Cookie',cookie).set('X-Organization-Id',organizationId).set('X-CSRF-Token',csrf.body.csrfToken as string).set('Idempotency-Key',key).send(body);
    const barrier=(await post('',{},'barrier-http-begin').expect(201)).body;
    expect((await post('',{},'barrier-http-begin').expect(201)).body).toEqual(barrier);
    await post(`/${barrier.id}/complete`,{},'barrier-http-incomplete').expect(409);
    const device=(await pool.query("SELECT id FROM devices WHERE organization_id=$1 AND status='ACTIVE' LIMIT 1",[organizationId])).rows[0]?.id as string;
    const grants=await request(app.getHttpServer()).get(`/api/v1/offline/configuration-barriers/${barrier.id}/grants?deviceId=${device}`)
      .set('Cookie',cookie).set('X-Organization-Id',organizationId).expect(200);
    for (const grant of grants.body) {
      const payload=JSON.stringify({organizationId,barrierId:barrier.id,grantId:grant.id,epoch:barrier.epoch,sequence:0,headHash:'0'.repeat(64),creationFrozen:true});
      const input={grantId:grant.id,sequence:0,headHash:'0'.repeat(64),signature:sign('sha256',Buffer.from(payload),{key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
      const path=`/${barrier.id}/checkpoints`,key=`checkpoint-${grant.id}`;
      await post(path,input,key).expect(201);await post(path,input,key).expect(201);
    }
    await post(`/${barrier.id}/complete`,{},'barrier-http-complete').expect(201);
    await post(`/${barrier.id}/complete`,{},'barrier-http-complete').expect(201);
    expect((await pool.query('SELECT count(*)::integer AS n FROM configuration_checkpoints WHERE barrier_id=$1',[barrier.id])).rows[0]?.n).toBe(grants.body.length);
  });
  it('T201/T202A composes real delivery into RLS ingestion and returns only stable signed ACKs after revocation',async()=>{
    const login=await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin','http://localhost:3000').send({email,password:'correct-password'}).expect(204);
    const cookie=(login.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0] ?? '';
    const csrf=await request(app.getHttpServer()).get('/api/v1/auth/csrf').set('Cookie',cookie).expect(200);
    const device=(await pool.query("SELECT id,authorized_by_user_id FROM devices WHERE organization_id=$1 AND status='ACTIVE' LIMIT 1",[organizationId])).rows[0];
    const register=randomUUID();await pool.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Delivery')",[register,organizationId,branchId]);
    const online=(path:string,body:object,key:string)=>request(app.getHttpServer()).post(`/api/v1/offline/${path}`)
      .set('Origin','http://localhost:3000').set('Cookie',cookie).set('X-Organization-Id',organizationId).set('X-CSRF-Token',csrf.body.csrfToken as string).set('Idempotency-Key',key).send(body);
    const bootstrap=(await online('bootstrap',{deviceId:device.id,branchId},'real-delivery-bootstrap').expect(201)).body;
    const config=JSON.parse(bootstrap.payload as string);
    const grantInput={grantId:config.grantId as string,bootstrapHash:createHash('sha256').update(bootstrap.payload as string).digest('hex'),deviceSequence:'0',headHash:null};
    const grantProof=sign('sha256',Buffer.from(offlineGrantProofPayload(grantInput)),{key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    const grant=(await online('authorize',{...grantInput,proof:grantProof},'real-delivery-grant').expect(201)).body.grant as string;
    const certificate=new DeviceCertificate(secret).issue({organizationId,deviceId:device.id,thumbprint:new DeviceCertificate(secret).thumbprint(keyPair.publicKey.export({type:'spki',format:'pem'}).toString())});
    const id=randomUUID(),session=randomUUID(),occurredAt=new Date().toISOString();
    const operation={id,actorId:device.authorized_by_user_id,organizationId,deviceId:device.id,sessionId:session,sequence:'1',sessionSequence:'1',previousHash:null,kind:'cash-session-open',grant,configVersion:config.configurationVersion,occurredAt,receivedAt:null,
      payload:{id:session,actorUserId:device.authorized_by_user_id,branchId,cashRegisterId:register,openingCash:'0.00',currency:'ARS',openedAt:occurredAt,status:'OPEN'}};
    const routing={version:1,keyId:'test-ingestion',operationId:id,certificate};
    const payloadHash=createHash('sha256').update(canonicalEnvelopeJson(operation)).digest('base64');
    const operationSignature=sign('sha256',Buffer.from(payloadHash,'base64'),{key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
    const cek=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cek,iv);cipher.setAAD(Buffer.from(canonicalEnvelopeJson(routing)));
    const ciphertext=Buffer.concat([cipher.update(canonicalEnvelopeJson({routing,operation,payloadHash,signature:operationSignature})),cipher.final(),cipher.getAuthTag()]);
    const rsa=createPublicKey(JSON.parse(process.env.OFFLINE_INGESTION_KEYS ?? '{}').keys['test-ingestion']);
    const unsigned={...routing,iv:iv.toString('base64'),wrappedCek:publicEncrypt({key:rsa,oaepHash:'sha256'},cek).toString('base64'),ciphertext:ciphertext.toString('base64'),ciphertextHash:createHash('sha256').update(ciphertext).digest('base64')};
    const envelope=canonicalEnvelopeJson({...unsigned,signature:sign('sha256',Buffer.from(canonicalEnvelopeJson(unsigned)),{key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')});
    await pool.query("UPDATE devices SET status='REVOKED' WHERE id=$1",[device.id]);
    await pool.query("UPDATE memberships SET status='REVOKED',revoked_at=now() WHERE organization_id=$1",[organizationId]);
    const deliver=async()=>{
      const nonce=await request(app.getHttpServer()).post('/api/v1/offline/delivery/challenge').set('Origin','http://localhost:3000').send({certificate}).expect(200);
      const challenge=nonce.body.challenge as string,envelopes=[envelope];
      const proof=sign('sha256',Buffer.from(deliveryProofPayload(challenge,envelopes)),{key:keyPair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
      return (await request(app.getHttpServer()).post('/api/v1/offline/delivery/push').set('Origin','http://localhost:3000').send({certificate,challenge,envelopes,proof}).expect(200)).body;
    };
    const first=await deliver();expect(Object.keys(first)).toEqual(['acks']);expect(first.acks).toHaveLength(1);
    expect(verifyOfflineAck(first.acks[0],signer.publicKey,'test-trusted',{operationId:id,envelopeHash:createHash('sha256').update(envelope).digest('hex')}).status).toBe('ACKED');
    expect(await deliver()).toEqual(first);
    expect((await pool.query('SELECT count(*)::integer AS n FROM cash_sessions WHERE id=$1',[session])).rows[0]?.n).toBe(1);
  });

});

