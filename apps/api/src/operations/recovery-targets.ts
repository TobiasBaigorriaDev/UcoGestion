export function verifyRecoveryTargets(backupCreatedAt: string, incidentAt: number, startedAt: number, completedAt: number) {
  const backup=Date.parse(backupCreatedAt);
  if(![backup,incidentAt,startedAt,completedAt].every(Number.isFinite) || backup>incidentAt || startedAt<incidentAt || completedAt<startedAt) throw new Error('Invalid recovery timeline.');
  const rpoSeconds=(incidentAt-backup)/1000, rtoSeconds=(completedAt-incidentAt)/1000;
  if(rpoSeconds>24*3600)throw new Error('RPO exceeds 24 hours.');
  if(rtoSeconds>8*3600)throw new Error('RTO exceeds 8 hours.');
  return {rpoSeconds,rtoSeconds};
}
