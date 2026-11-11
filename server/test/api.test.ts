import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import type { AnalysisResult } from '../src/types.js';

const samplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples');
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ samplesDir });
});
afterAll(() => app.close());

function multipart(files: Array<{ name: string; content: string }>, fields: Record<string, string> = {}) {
  const boundary = '----incidentlens';
  const parts = [
    ...Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    ...files.map(
      (f) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: text/plain\r\n\r\n${f.content}\r\n`,
    ),
  ];
  return {
    payload: parts.join('') + `--${boundary}--\r\n`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('POST /api/analyze', () => {
  it('analyzes uploaded files of mixed formats', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      ...multipart(
        [
          { name: 'gateway.log', content: '2026-11-10T08:00:00.000Z ERROR upstream failed trace_id=t1\n' },
          { name: 'orders.jsonl', content: '{"time":"2026-11-10T08:00:00.010Z","level":"error","msg":"db down","traceId":"t1"}\n' },
        ],
        { windowMs: '2000' },
      ),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AnalysisResult>();
    expect(body.options.windowMs).toBe(2000);
    expect(body.files.map((f) => f.format)).toEqual(['text', 'json']);
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0].services).toEqual(['gateway', 'orders']);
  });

  it('rejects requests without files', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/analyze', ...multipart([]) });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid options', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      ...multipart([{ name: 'a.log', content: '2026-11-10T08:00:00Z ERROR x' }], { minConfidence: '7' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('bundled sample scenario (end to end)', () => {
  let result: AnalysisResult;
  beforeAll(async () => {
    const res = await app.inject({ method: 'POST', url: '/api/analyze/samples' });
    expect(res.statusCode).toBe(200);
    result = res.json<AnalysisResult>();
  });

  it('parses all sample files without warnings', () => {
    expect(result.files).toHaveLength(4);
    expect(result.warnings).toEqual([]);
  });

  it('finds the checkout failure as an exact trace-correlated incident', () => {
    const inc = result.incidents.find((i) => i.correlationKeys.includes('traceId=tr-1001'))!;
    expect(inc.correlation).toBe('exact');
    expect(inc.services.sort()).toEqual(['api-gateway', 'order-service', 'payment-service']);
  });

  it('links the inventory DB failure to the order/gateway errors heuristically', () => {
    const inc = result.incidents.find((i) => i.services.includes('inventory-service'))!;
    expect(inc.correlation).toBe('heuristic');
    expect(inc.services.sort()).toEqual(['api-gateway', 'inventory-service', 'order-service']);
    expect(inc.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps the unrelated TLS and rate-limit warnings out of incidents', () => {
    const messages = result.incidents.flatMap((i) => i.timeline.map((t) => t.event.message));
    expect(messages.some((m) => m.includes('TLS certificate'))).toBe(false);
    expect(messages.some((m) => m.includes('throttling'))).toBe(false);
  });

  it('reports the config reload failure as an isolated incident', () => {
    const inc = result.incidents.find((i) => i.title.includes('routes.yaml'))!;
    expect(inc.correlation).toBe('isolated');
    expect(result.incidents).toHaveLength(3);
  });
});
