import { expect, it } from 'vitest';
import { verifyRecoveryTargets } from '../src/operations/recovery-targets.js';

it('T233 enforces RPO <=24 hours and measures RTO <=8 hours including smoke', () => {
  const incident=Date.parse('2026-10-09T12:00:00Z');
  expect(verifyRecoveryTargets(new Date(incident-24*3600000).toISOString(),incident,incident,incident+8*3600000))
    .toEqual({rpoSeconds:86400,rtoSeconds:28800});
  expect(()=>verifyRecoveryTargets(new Date(incident-24*3600000-1).toISOString(),incident,incident,incident)).toThrow(/RPO/);
  expect(()=>verifyRecoveryTargets(new Date(incident).toISOString(),incident,incident,incident+8*3600000+1)).toThrow(/RTO/);
  expect(()=>verifyRecoveryTargets('invalid',incident,incident,incident)).toThrow();
  expect(()=>verifyRecoveryTargets(new Date(incident).toISOString(),incident,incident+2*3600000,incident+9*3600000)).toThrow(/RTO/);
});
