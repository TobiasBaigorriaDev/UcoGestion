import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { OfflineDatabase } from '../src/offline/offline-database.js';
import { authorizationFixture, org, device, actor, branch } from './offline-authorization.fixture.js';
afterEach(async () => { await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

it('T187 verifies Node signatures against pinned trust and stores only encrypted identity-bound authorization', async () => {
  const fixture = await authorizationFixture();
  try {
    await fixture.authorization.install(actor, fixture.signed, fixture.jwt());
    expect((await fixture.authorization.require(actor)).claims).toEqual(fixture.claims);
    const record = await fixture.db.getEncrypted(actor, 'authorization', 'current');
    expect(new TextDecoder().decode(record)).not.toContain(actor);
    fixture.keys.lock();
    await expect(fixture.authorization.require(actor)).rejects.toThrow();
  } finally { fixture.db.close(); }
});

it('T187 rejects forged grants, cross-identity context and expiry without installing authorization', async () => {
  const fixture = await authorizationFixture();
  try {
    await expect(fixture.authorization.install(actor, fixture.signed, `${fixture.jwt().slice(0, -4)}AAAA`)).rejects.toThrow();
    await expect(fixture.authorization.install(actor, fixture.signed, fixture.jwt({ ...fixture.claims, actorUserId: branch }))).rejects.toThrow();
    await expect(fixture.authorization.install(actor, fixture.signed, fixture.jwt({ ...fixture.claims,
      iat: fixture.claims.iat - 72 * 60 * 60, exp: fixture.claims.iat }))).rejects.toThrow();
    expect(await fixture.db.getEncrypted(actor, 'authorization', 'current')).toBeUndefined();
  } finally { fixture.db.close(); }
});
