// Regression tests for issues found in code review.
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { correlate } from '../src/correlation/incidents.js';
import { extractFeatures } from '../src/correlation/features.js';
import { parseJsonLines } from '../src/parsing/jsonParser.js';
import { normalizeTimestamp } from '../src/parsing/normalize.js';
import { parseTextLines } from '../src/parsing/textParser.js';

const T = Date.UTC(2026, 10, 10, 8, 15, 3, 123);

describe('timestamps of every epoch unit', () => {
  it.each([
    ['seconds', T / 1000],
    ['milliseconds', T],
    ['microseconds', T * 1000],
    ['nanoseconds (OTel)', T * 1_000_000],
  ])('%s', (_, raw) => {
    expect(normalizeTimestamp(raw)).toBe(T);
  });

  it('rejects absurd values as a warning instead of crashing the request', () => {
    expect(normalizeTimestamp(1e30)).toBeNull();
    const result = analyze([{ name: 'x.jsonl', content: '{"ts":1e30,"level":"error","msg":"boom"}\n' }]);
    expect(result.totalEvents).toBe(0);
    expect(result.warnings).toHaveLength(1);
  });

  it('parses RFC 2822 timestamps without ISO rewrites mangling them', () => {
    expect(normalizeTimestamp('Tue, 10 Nov 2026 08:15:03 GMT')).toBe(Date.UTC(2026, 10, 10, 8, 15, 3));
  });
});

describe('text level aliases', () => {
  it.each(['CRIT', 'PANIC', 'SEVERE', 'ALERT', 'NOTICE'])('%s lines become events, not continuations', (level) => {
    const { records } = parseTextLines(
      `2026-11-10T08:00:00Z INFO first\n2026-11-10T08:00:01Z ${level} disk full`,
      'svc.log',
    );
    expect(records).toHaveLength(2);
  });

  it('CRIT maps to FATAL end to end', () => {
    const result = analyze([{ name: 'svc.log', content: '2026-11-10T08:00:01Z CRIT disk full\n' }]);
    expect(result.incidents[0].severity).toBe('FATAL');
  });
});

describe('placeholder correlation IDs', () => {
  it('does not merge unrelated errors that carry an all-zero or "-" trace ID', () => {
    const content = [
      '{"time":"2026-11-10T08:00:00Z","level":"error","msg":"alpha broke","traceId":"00000000000000000000000000000000"}',
      '{"time":"2026-11-10T09:00:00Z","level":"error","msg":"beta broke","traceId":"00000000000000000000000000000000"}',
      '{"time":"2026-11-10T10:00:00Z","level":"error","msg":"gamma broke","traceId":"-"}',
    ].join('\n');
    expect(analyze([{ name: 'svc.jsonl', content }]).incidents).toHaveLength(3);
  });
});

describe('JSON metadata with dotted aliases', () => {
  it('keeps sibling fields when log.level / service.name are picked', () => {
    const { records } = parseJsonLines(
      '{"time":"2026-11-10T08:00:00Z","log":{"level":"error","logger":"db"},"service":{"name":"billing","version":"1.2"},"message":"m"}',
      'x.jsonl',
    );
    expect(records[0]).toMatchObject({ level: 'error', service: 'billing' });
    expect(records[0].metadata).toEqual({ log: { logger: 'db' }, service: { version: '1.2' } });
  });
});

describe('bounded cost on hostile input', () => {
  it('parses and extracts features from a very long line quickly', () => {
    const line = `2026-11-10T08:00:00Z ERROR ${'a'.repeat(200_000)}`;
    const start = performance.now();
    const result = analyze([{ name: 'svc.log', content: line }]);
    extractFeatures(result.incidents[0].timeline[0].event);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('handles thousands of same-timestamp errors sharing a path without quadratic blow-up', () => {
    const base = Date.UTC(2026, 10, 10, 8, 0, 0);
    const events = Array.from({ length: 5000 }, (_, i) => ({
      id: `svc.log#${i + 1}`,
      timestamp: new Date(base).toISOString(),
      epochMs: base,
      service: `svc-${i}`,
      level: 'ERROR' as const,
      message: `GET /api/pay failed with 503 PAYMENT_DOWN`,
      sourceFile: 'svc.log',
      sourceLine: i + 1,
      metadata: {},
    }));
    const start = performance.now();
    const incidents = correlate(events, { windowMs: 5000, minConfidence: 0.5 });
    expect(performance.now() - start).toBeLessThan(3000);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].timeline).toHaveLength(5000);
  });
});
