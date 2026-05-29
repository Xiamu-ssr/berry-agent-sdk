// ============================================================
// @berry-agent/a8s-server — Metrics
// ============================================================
//
// In-process counters + gauges + histograms, exposed via /metrics in
// Prometheus exposition format. No external dependency on prom-client
// — we ship a few hundred bytes of plain JS instead of a 200KB
// runtime, because our metric surface is small and stable.
//
// Naming convention: `a8s_<noun>_<unit>` (snake_case), labels are flat
// strings. See https://prometheus.io/docs/practices/naming/

export interface MetricLabels {
  [key: string]: string;
}

function labelKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function renderLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',') + '}';
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export class Counter {
  private readonly values = new Map<string, number>();
  private readonly seenLabels = new Map<string, MetricLabels>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: MetricLabels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
    if (!this.seenLabels.has(key)) this.seenLabels.set(key, labels);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.values) {
      const labels = this.seenLabels.get(key) ?? {};
      lines.push(`${this.name}${renderLabels(labels)} ${val}`);
    }
    return lines.join('\n');
  }
}

export class Gauge {
  private readonly values = new Map<string, number>();
  private readonly seenLabels = new Map<string, MetricLabels>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels: MetricLabels = {}): void {
    const key = labelKey(labels);
    this.values.set(key, value);
    if (!this.seenLabels.has(key)) this.seenLabels.set(key, labels);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, val] of this.values) {
      const labels = this.seenLabels.get(key) ?? {};
      lines.push(`${this.name}${renderLabels(labels)} ${val}`);
    }
    return lines.join('\n');
  }
}

/** Pre-defined buckets in seconds; reasonable for HTTP request durations. */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export class Histogram {
  private readonly buckets: number[];
  private readonly counts = new Map<string, number[]>(); // labelKey -> bucket counts (last = +Inf)
  private readonly sums = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private readonly seenLabels = new Map<string, MetricLabels>();

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[] = DEFAULT_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const key = labelKey(labels);
    if (!this.counts.has(key)) {
      this.counts.set(key, new Array(this.buckets.length + 1).fill(0));
      this.sums.set(key, 0);
      this.totals.set(key, 0);
      this.seenLabels.set(key, labels);
    }
    const counts = this.counts.get(key)!;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) counts[i]++;
    }
    counts[this.buckets.length]++; // +Inf
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, counts] of this.counts) {
      const labels = this.seenLabels.get(key) ?? {};
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += counts[i];
        const labeled = { ...labels, le: String(this.buckets[i]) };
        lines.push(`${this.name}_bucket${renderLabels(labeled)} ${cumulative}`);
      }
      cumulative += counts[this.buckets.length];
      lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: '+Inf' })} ${cumulative}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${this.totals.get(key) ?? 0}`);
    }
    return lines.join('\n');
  }
}

/**
 * Standard a8s metric set. The server owns a single instance and the
 * /metrics route renders it. Modules touch metrics by reading the
 * fields directly.
 */
export class A8sMetrics {
  readonly requestsTotal = new Counter('a8s_requests_total', 'Total HTTP requests received, by route and status.');
  readonly requestDurationSeconds = new Histogram('a8s_request_duration_seconds', 'HTTP request duration, by route.');
  readonly workersTotal = new Gauge('a8s_workers_total', 'Registered workers by state.');
  readonly agentsTotal = new Gauge('a8s_agents_total', 'Currently assigned agents.');
  readonly wakesTotal = new Counter('a8s_wakes_total', 'Wakes delivered, by outcome.');

  render(): string {
    return [
      this.requestsTotal.render(),
      this.requestDurationSeconds.render(),
      this.workersTotal.render(),
      this.agentsTotal.render(),
      this.wakesTotal.render(),
    ].filter((s) => !s.endsWith('\n') ? s : s).join('\n\n') + '\n';
  }
}
