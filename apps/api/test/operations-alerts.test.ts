import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MetricsService } from '../src/core/observability/metrics.service.js';

describe('T230 operational alerts', () => {
  it('publishes dependency and durable operational gauges without identity labels', async () => {
    const metrics = new MetricsService();
    metrics.recordDatabaseReadiness(false);
    metrics.recordOperationalSnapshot({ deadLetters: 2, syncPendingAgeSeconds: 900, conflicts: 3 });
    const body = await metrics.render();
    expect(body).toContain('uconext_database_ready 0');
    expect(body).toContain('uconext_outbox_dead_letters 2');
    expect(body).toContain('uconext_sync_pending_age_seconds 900');
    expect(body).toContain('uconext_unreviewed_conflicts 3');
    expect(body).not.toContain('organization_id=');
    metrics.recordSyncResult('RETRY'); metrics.recordSyncResult('ACKED');
    expect(await metrics.render()).toContain('uconext_sync_operations_total{result="RETRY"} 1');
  });
  it('defines persistent alerts and a minimum HTTP traffic gate', () => {
    const rules = readFileSync('../../observability/operations-alerts.yaml', 'utf8');
    for (const name of ['ReadinessUnavailable', 'DatabaseUnavailable', 'HttpErrorRate', 'DeadLetterJobs', 'SyncFailures', 'UnreviewedConflicts', 'OperationalMonitorStale']) {
      expect(rules).toContain(`alert: ${name}`);
    }
    expect(rules).toContain('for: 10m');
    expect(rules).toContain('>= 20');
  });
});
