import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

type HttpMetricLabels = 'method' | 'route' | 'status_code';

export interface HttpMetric {
  readonly durationMs: number;
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
}

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly databaseReady = this.gauge('uconext_database_ready', 'Latest bounded PostgreSQL readiness probe.');
  private readonly deadLetters = this.gauge('uconext_outbox_dead_letters', 'Durable dead-letter jobs in monitored organizations.');
  private readonly syncAge = this.gauge('uconext_sync_pending_age_seconds', 'Oldest server-side pending sync operation age.');
  private readonly conflicts = this.gauge('uconext_unreviewed_conflicts', 'Inventory and cash conflicts awaiting review.');
  private readonly snapshotTime = this.gauge('uconext_operations_snapshot_timestamp_seconds', 'Last complete operational snapshot.');
  private readonly syncResults = new Counter<'result'>({ name: 'uconext_sync_operations_total', help: 'Envelope delivery results including recoverable failures.', labelNames: ['result'], registers: [this.registry] });
  private readonly requestDuration = new Histogram<HttpMetricLabels>({
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'],
    name: 'uconext_http_request_duration_seconds',
    registers: [this.registry],
  });
  private readonly requests = new Counter<HttpMetricLabels>({
    help: 'Total completed HTTP requests.',
    labelNames: ['method', 'route', 'status_code'],
    name: 'uconext_http_requests_total',
    registers: [this.registry],
  });
  private readonly inventoryDivergences = new Gauge({
    help: 'Inventory ledger and projection divergences in the latest completed verification.',
    name: 'uconext_inventory_ledger_divergences', registers: [this.registry],
  });
  private readonly inventoryVerificationFailures = new Counter({
    help: 'Failed inventory ledger verification passes.',
    name: 'uconext_inventory_ledger_verification_failures_total', registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ prefix: 'uconext_', register: this.registry });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  recordHttpRequest(metric: HttpMetric): void {
    const labels = {
      method: metric.method,
      route: metric.route,
      status_code: String(metric.statusCode),
    };
    this.requests.inc(labels);
    this.requestDuration.observe(labels, metric.durationMs / 1_000);
  }

  recordInventoryVerification(divergent: number): void { this.inventoryDivergences.set(divergent); }
  recordInventoryVerificationFailure(): void { this.inventoryVerificationFailures.inc(); }

  recordDatabaseReadiness(ready: boolean): void { this.databaseReady.set(ready ? 1 : 0); }
  recordSyncResult(result: 'ACKED' | 'SECURITY_REJECTED' | 'RETRY'): void { this.syncResults.inc({ result }); }
  recordOperationalSnapshot(snapshot: { deadLetters: number; syncPendingAgeSeconds: number; conflicts: number }): void {
    this.deadLetters.set(snapshot.deadLetters);
    this.syncAge.set(snapshot.syncPendingAgeSeconds);
    this.conflicts.set(snapshot.conflicts);
    this.snapshotTime.set(Date.now() / 1000);
  }
  private gauge(name: string, help: string): Gauge {
    return new Gauge({ name, help, registers: [this.registry] });
  }
}
