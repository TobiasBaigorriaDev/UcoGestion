import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateEnvelopeOrder, type EnvelopeOrderRecord } from '../src/modules/offline-sync/offline-envelope-order.js';

const org = randomUUID(), device = randomUUID(), session = randomUUID(), id = randomUUID();
const hash = Buffer.alloc(32, 1).toString('base64');
const envelopeHash = 'b'.repeat(64);
const opening = { id, organizationId: org, deviceId: device, sessionId: session, sequence: '1', sessionSequence: '1',
  previousHash: null, kind: 'cash-session-open' as const, operationHash: hash, envelopeHash };
const row: EnvelopeOrderRecord = { ...opening, status: 'ACKED' };
describe('T200B envelope chain and dependencies', () => {
  it('requires contiguous device and session chains and an applied opening', () => {
    expect(validateEnvelopeOrder(opening, [])).toBe('READY');
    const sale = { ...opening, id: randomUUID(), kind: 'sale-confirm' as const, sequence: '2', sessionSequence: '2', previousHash: hash };
    expect(validateEnvelopeOrder(sale, [])).toBe('WAITING_DEPENDENCY');
    expect(validateEnvelopeOrder(sale, [{ ...row, status: 'PENDING' }])).toBe('WAITING_DEPENDENCY');
    expect(validateEnvelopeOrder(sale, [{ ...row, status: 'SECURITY_REJECTED' }])).toBe('WAITING_DEPENDENCY');
    expect(validateEnvelopeOrder(sale, [row])).toBe('READY');
    expect(validateEnvelopeOrder({ ...sale, previousHash: Buffer.alloc(32, 2).toString('base64') }, [row])).toBe('CONFLICT');
    expect(validateEnvelopeOrder({ ...sale, sessionSequence: '3' }, [row])).toBe('WAITING_DEPENDENCY');
    expect(validateEnvelopeOrder({ ...sale, sessionId: randomUUID() }, [row])).toBe('WAITING_DEPENDENCY');
  });
  it('binds replay to the original ID, payload, envelope bytes and device sequence', () => {
    expect(validateEnvelopeOrder(opening, [row])).toBe('ACKED');
    expect(validateEnvelopeOrder(opening, [{ ...row, status: 'SECURITY_REJECTED' }])).toBe('SECURITY_REJECTED');
    expect(validateEnvelopeOrder({ ...opening, envelopeHash: 'c'.repeat(64) }, [row])).toBe('CONFLICT');
    expect(validateEnvelopeOrder({ ...opening, operationHash: Buffer.alloc(32, 2).toString('base64') }, [row])).toBe('CONFLICT');
    expect(validateEnvelopeOrder({ ...opening, id: randomUUID() }, [row])).toBe('CONFLICT');
    expect(validateEnvelopeOrder({ ...opening, previousHash: hash }, [])).toBe('CONFLICT');
  });
});
