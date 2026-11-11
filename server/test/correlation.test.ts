import { describe, expect, it } from 'vitest';
import { extractFeatures } from '../src/correlation/features.js';
import { mentionsService, scorePair } from '../src/correlation/heuristic.js';
import { correlate } from '../src/correlation/incidents.js';
import type { Level, LogEvent } from '../src/types.js';

const BASE = Date.UTC(2026, 10, 10, 8, 0, 0);
let line = 0;

function ev(service: string, offsetMs: number, level: Level, message: string, extra: Partial<LogEvent> = {}): LogEvent {
  line += 1;
  return {
    id: `${service}.log#${line}`,
    timestamp: new Date(BASE + offsetMs).toISOString(),
    epochMs: BASE + offsetMs,
    service,
    level,
    message,
    sourceFile: `${service}.log`,
    sourceLine: line,
    metadata: {},
    ...extra,
  };
}

const opts = { windowMs: 5000, minConfidence: 0.5 };

describe('exact correlation', () => {
  it('groups events across services by traceId, including INFO context', () => {
    const events = [
      ev('gateway', 0, 'INFO', 'request in', { traceId: 't1' }),
      ev('orders', 10, 'INFO', 'creating order', { traceId: 't1' }),
      ev('payments', 3000, 'ERROR', 'charge failed', { traceId: 't1' }),
      ev('gateway', 3010, 'ERROR', 'POST /api/orders 502', { traceId: 't1' }),
    ];
    const [incident, ...rest] = correlate(events, opts);
    expect(rest).toHaveLength(0);
    expect(incident.correlation).toBe('exact');
    expect(incident.confidence).toBeNull();
    expect(incident.timeline).toHaveLength(4);
    expect(incident.timeline.every((t) => t.membership.kind === 'exact')).toBe(true);
    expect(incident.services).toEqual(['gateway', 'orders', 'payments']);
    expect(incident.correlationKeys).toEqual(['traceId=t1']);
  });

  it('bridges traceId and requestId when one event carries both', () => {
    const events = [
      ev('gateway', 0, 'ERROR', 'failed', { requestId: 'r1', traceId: 't1' }),
      ev('orders', 5, 'INFO', 'step', { traceId: 't1' }),
      ev('lb', 6, 'INFO', 'access', { requestId: 'r1' }),
    ];
    const incidents = correlate(events, opts);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].timeline).toHaveLength(3);
  });

  it('keeps different trace IDs apart even when they happen at the same time', () => {
    const events = [
      ev('a', 0, 'ERROR', 'failure one', { traceId: 't1' }),
      ev('b', 0, 'ERROR', 'failure two', { traceId: 't2' }),
    ];
    expect(correlate(events, opts)).toHaveLength(2);
  });

  it('does not create incidents from traces without errors', () => {
    const events = [ev('a', 0, 'INFO', 'ok', { traceId: 't1' }), ev('b', 1, 'WARN', 'slow', { traceId: 't1' })];
    expect(correlate(events, opts)).toEqual([]);
  });
});

describe('heuristic correlation', () => {
  it('links nearby errors that share endpoint, status code and a service mention', () => {
    const events = [
      ev('inventory-service', 0, 'ERROR', 'POST /api/inventory/reserve -> 503 Service Unavailable'),
      ev('order-service', 200, 'ERROR', 'inventory-service returned 503 for /api/inventory/reserve'),
    ];
    const [incident, ...rest] = correlate(events, opts);
    expect(rest).toHaveLength(0);
    expect(incident.correlation).toBe('heuristic');
    expect(incident.confidence).toBeGreaterThanOrEqual(0.5);
    expect(incident.confidence).toBeLessThan(1);

    const [first, second] = incident.timeline;
    expect(first.membership.kind).toBe('seed');
    expect(second.membership).toMatchObject({ kind: 'heuristic', matchedEventId: first.event.id });
    if (second.membership.kind !== 'heuristic') throw new Error('unreachable');
    expect(second.membership.reasons.join(' ')).toMatch(/shared endpoint \/api\/inventory\/reserve/);
    expect(second.membership.reasons.join(' ')).toMatch(/shared error code http:503/);
    expect(incident.heuristicLinks).toHaveLength(1);
  });

  it('confidence decreases as events get further apart', () => {
    const a = ev('x', 0, 'ERROR', 'DB_CONN_TIMEOUT acquiring connection');
    const near = ev('y', 100, 'ERROR', 'request failed DB_CONN_TIMEOUT');
    const far = ev('y', 4500, 'ERROR', 'request failed DB_CONN_TIMEOUT');
    const sNear = scorePair(a, extractFeatures(a), near, extractFeatures(near), 5000)!;
    const sFar = scorePair(a, extractFeatures(a), far, extractFeatures(far), 5000)!;
    expect(sNear.confidence).toBeGreaterThan(sFar.confidence);
  });

  it('respects the configurable time window', () => {
    const events = [
      ev('inventory-service', 0, 'ERROR', 'POST /api/inventory/reserve -> 503'),
      ev('order-service', 3000, 'ERROR', 'inventory-service returned 503 for /api/inventory/reserve'),
    ];
    expect(correlate(events, { ...opts, windowMs: 5000 })).toHaveLength(1);
    expect(correlate(events, { ...opts, windowMs: 2000 })).toHaveLength(2);
  });

  it('attaches an exact group (with its INFO context) to a heuristic incident', () => {
    const events = [
      ev('inventory-service', 0, 'ERROR', 'POST /api/inventory/reserve -> 503'),
      ev('order-service', 50, 'INFO', 'reserving stock', { requestId: 'r9' }),
      ev('order-service', 100, 'ERROR', 'inventory-service returned 503 for /api/inventory/reserve', { requestId: 'r9' }),
    ];
    const [incident] = correlate(events, opts);
    expect(incident.timeline).toHaveLength(3);
    const info = incident.timeline.find((t) => t.event.level === 'INFO')!;
    expect(info.membership).toMatchObject({ kind: 'heuristic', key: 'requestId=r9' });
  });
});

describe('unrelated events are not grouped', () => {
  it('does not link events that are only close in time', () => {
    const events = [
      ev('payment-service', 0, 'ERROR', 'Card processor call failed: ETIMEDOUT'),
      ev('auth-service', 100, 'ERROR', 'LDAP bind rejected for admin user'),
      ev('gateway', 150, 'WARN', 'client exceeded rate limit, throttling'),
    ];
    const incidents = correlate(events, opts);
    expect(incidents).toHaveLength(2); // two separate errors; the WARN alone is not an incident
    expect(incidents.every((i) => i.correlation === 'isolated')).toBe(true);
  });

  it('time proximity alone stays below the default threshold', () => {
    const a = ev('a', 0, 'ERROR', 'alpha subsystem exploded');
    const b = ev('b', 0, 'ERROR', 'beta queue rejected message');
    const score = scorePair(a, extractFeatures(a), b, extractFeatures(b), 5000)!;
    expect(score.confidence).toBeLessThan(0.5);
  });

  it('does not link similar errors outside the time window', () => {
    const events = [
      ev('orders', 0, 'ERROR', 'GET /api/orders 500 INTERNAL_ERROR'),
      ev('orders', 60_000, 'ERROR', 'GET /api/orders 500 INTERNAL_ERROR'),
    ];
    expect(correlate(events, opts)).toHaveLength(2);
  });

  it('ignores generic words like "error" and "failed" as shared keywords', () => {
    const a = ev('a', 0, 'ERROR', 'request failed with error');
    const b = ev('b', 0, 'ERROR', 'error: request failed');
    expect(extractFeatures(a).keywords.size).toBe(0);
    expect(scorePair(a, extractFeatures(a), b, extractFeatures(b), 5000)!.confidence).toBeLessThan(0.5);
  });
});

describe('mentionsService', () => {
  it('matches full names and stems on word boundaries', () => {
    expect(mentionsService('call to inventory-service failed', 'inventory-service')).toBe(true);
    expect(mentionsService('inventory unavailable', 'inventory-service')).toBe(true);
    expect(mentionsService('reinventory job', 'inventory-service')).toBe(false);
  });
});
