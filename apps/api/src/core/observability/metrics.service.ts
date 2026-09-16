import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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
}
