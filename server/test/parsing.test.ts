import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/parsing/detect.js';
import { parseFile } from '../src/parsing/index.js';
import { parseJsonLines } from '../src/parsing/jsonParser.js';
import { parseTextLines } from '../src/parsing/textParser.js';

describe('detectFormat', () => {
  it('detects NDJSON', () => {
    expect(detectFormat('{"msg":"a"}\n{"msg":"b"}\n')).toBe('json');
  });
  it('detects text', () => {
    expect(detectFormat('2026-11-10T08:00:00Z INFO hello\n')).toBe('text');
  });
  it('treats mostly-text files with a stray JSON line as text', () => {
    expect(detectFormat('2026-11-10T08:00:00Z INFO a\n2026-11-10T08:00:01Z INFO b\n{"x":1}\n')).toBe('text');
  });
});

describe('parseJsonLines', () => {
  it('maps common field aliases and keeps the rest as metadata', () => {
    const { records, warnings } = parseJsonLines(
      '{"time":"2026-11-10T08:15:00Z","level":"error","msg":"boom","traceId":"t1","request_id":"r1","path":"/api/x"}\n',
      'svc.jsonl',
    );
    expect(warnings).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceFile: 'svc.jsonl',
      sourceLine: 1,
      timestamp: '2026-11-10T08:15:00Z',
      level: 'error',
      message: 'boom',
      traceId: 't1',
      requestId: 'r1',
      metadata: { path: '/api/x' },
    });
  });

  it('reads nested keys like trace.id and service.name', () => {
    const { records } = parseJsonLines(
      '{"@timestamp":"2026-11-10T08:15:00Z","log":{"level":"warn"},"message":"m","trace":{"id":"abc"},"service":{"name":"billing"}}',
      'x.jsonl',
    );
    expect(records[0]).toMatchObject({ level: 'warn', traceId: 'abc', service: 'billing' });
  });

  it('reports invalid lines with their line number and keeps going', () => {
    const { records, warnings } = parseJsonLines('{"msg":"ok","ts":1}\nnot json\n[1,2]\n{"msg":"ok2","ts":2}', 'a.jsonl');
    expect(records.map((r) => r.sourceLine)).toEqual([1, 4]);
    expect(warnings).toEqual([
      { sourceFile: 'a.jsonl', sourceLine: 2, reason: 'Invalid JSON' },
      { sourceFile: 'a.jsonl', sourceLine: 3, reason: 'JSON line is not an object' },
    ]);
  });
});

describe('parseTextLines', () => {
  it('parses timestamp, level, logger, message and key=value pairs', () => {
    const { records } = parseTextLines(
      '2026-11-10T08:15:03.140Z ERROR [http] POST /api/orders failed status=502 request_id=req-1 trace_id=tr-1 note="two words"',
      'api-gateway.log',
    );
    expect(records[0]).toMatchObject({
      timestamp: '2026-11-10T08:15:03.140Z',
      level: 'ERROR',
      traceId: 'tr-1',
      requestId: 'req-1',
      metadata: { logger: 'http', status: '502', note: 'two words' },
    });
    expect(records[0].message).toContain('POST /api/orders failed');
  });

  it('accepts log4j-style "yyyy-mm-dd hh:mm:ss,SSS" timestamps', () => {
    const { records } = parseTextLines('2026-11-10 08:20:01,850 WARN pool low', 'inv.log');
    expect(records[0]).toMatchObject({ timestamp: '2026-11-10 08:20:01,850', level: 'WARN', message: 'pool low' });
  });

  it('attaches continuation lines (stack traces) to the previous event', () => {
    const { records, warnings } = parseTextLines(
      '2026-11-10T08:00:00Z ERROR crash\n    at a (x.js:1)\n    at b (y.js:2)\n2026-11-10T08:00:01Z INFO next',
      'svc.log',
    );
    expect(warnings).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[0].metadata.continuation).toEqual(['    at a (x.js:1)', '    at b (y.js:2)']);
  });

  it('warns on unrecognized lines before the first entry', () => {
    const { warnings } = parseTextLines('garbage\n2026-11-10T08:00:00Z INFO ok', 'svc.log');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sourceLine).toBe(1);
  });
});

describe('parseFile', () => {
  it('produces normalized events and reports records without a usable timestamp', () => {
    const parsed = parseFile({
      name: 'order-service.jsonl',
      content: '{"time":"2026-11-10T08:00:00Z","level":"info","msg":"ok"}\n{"level":"error","msg":"no time"}\n',
    });
    expect(parsed.format).toBe('json');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].service).toBe('order-service');
    expect(parsed.warnings[0]).toMatchObject({ sourceLine: 2 });
  });
});
