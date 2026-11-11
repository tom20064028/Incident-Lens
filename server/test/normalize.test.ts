import { describe, expect, it } from 'vitest';
import { normalizeLevel, normalizeRecord, normalizeTimestamp, serviceFromFilename } from '../src/parsing/normalize.js';

describe('normalizeLevel', () => {
  it.each([
    ['warning', 'WARN'],
    ['ERR', 'ERROR'],
    ['critical', 'FATAL'],
    [' Info ', 'INFO'],
    [50, 'ERROR'],
    [40, 'WARN'],
    [60, 'FATAL'],
    [10, 'TRACE'],
    [undefined, 'INFO'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeLevel(raw)).toBe(expected);
  });
});

describe('normalizeTimestamp', () => {
  const expected = Date.UTC(2026, 10, 10, 8, 15, 3, 140);
  it.each([
    ['2026-11-10T08:15:03.140Z'],
    ['2026-11-10 08:15:03,140'], // no zone -> UTC
    ['2026-11-10T08:15:03.140123Z'], // microseconds truncated
    ['2026-11-10T10:15:03.140+02:00'],
    [expected], // epoch ms
    [expected / 1000], // epoch seconds
    [String(expected)],
  ])('%s', (raw) => {
    expect(normalizeTimestamp(raw)).toBe(expected);
  });

  it('returns null for missing or garbage values', () => {
    expect(normalizeTimestamp(undefined)).toBeNull();
    expect(normalizeTimestamp('yesterday')).toBeNull();
  });
});

describe('serviceFromFilename', () => {
  it('strips extensions and directories', () => {
    expect(serviceFromFilename('order-service.jsonl')).toBe('order-service');
    expect(serviceFromFilename('logs/api.2026-11-10.log')).toBe('api');
  });
});

describe('normalizeRecord', () => {
  it('builds a LogEvent with defaults from the filename', () => {
    const ev = normalizeRecord({
      sourceFile: 'payment-service.jsonl',
      sourceLine: 7,
      timestamp: Date.UTC(2026, 10, 10, 8, 15, 3, 100),
      level: 50,
      message: 'boom',
      traceId: 't1',
      metadata: { path: '/api/payments' },
    });
    expect(ev).toEqual({
      id: 'payment-service.jsonl#7',
      timestamp: '2026-11-10T08:15:03.100Z',
      epochMs: Date.UTC(2026, 10, 10, 8, 15, 3, 100),
      service: 'payment-service',
      level: 'ERROR',
      message: 'boom',
      traceId: 't1',
      requestId: undefined,
      sourceFile: 'payment-service.jsonl',
      sourceLine: 7,
      metadata: { path: '/api/payments' },
    });
  });

  it('prefers an explicit service field over the filename', () => {
    const ev = normalizeRecord({ sourceFile: 'x.log', sourceLine: 1, timestamp: 0, level: 'info', message: '', service: 'billing', metadata: {} });
    expect('service' in ev && ev.service).toBe('billing');
  });

  it('returns an error for an invalid timestamp', () => {
    expect(normalizeRecord({ sourceFile: 'x.log', sourceLine: 1, timestamp: 'nope', level: 'info', message: '', metadata: {} })).toHaveProperty('error');
  });
});
