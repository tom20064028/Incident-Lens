import { z } from 'zod';
import type { ParseWarning, RawRecord } from '../types.js';

const jsonLine = z.record(z.string(), z.unknown());

// Common field aliases across loggers (pino, winston, bunyan, ECS, OpenTelemetry-style).
const TIMESTAMP_KEYS = ['timestamp', '@timestamp', 'time', 'ts', 'date'];
const LEVEL_KEYS = ['level', 'severity', 'lvl', 'log.level', 'levelname'];
const MESSAGE_KEYS = ['message', 'msg', 'event', 'text'];
const SERVICE_KEYS = ['service', 'service.name', 'app', 'serviceName'];
const TRACE_KEYS = ['traceId', 'trace_id', 'trace.id', 'traceID'];
const REQUEST_KEYS = ['requestId', 'request_id', 'reqId', 'req_id', 'correlationId', 'correlation_id'];

/** Read a key that may be flat ("trace.id") or nested ({ trace: { id } }). */
function read(obj: Record<string, unknown>, key: string): unknown {
  if (key in obj) return obj[key];
  const parts = key.split('.');
  if (parts.length < 2) return undefined;
  let cur: unknown = obj;
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function pick(obj: Record<string, unknown>, keys: string[], used: Set<string>): unknown {
  for (const key of keys) {
    const value = read(obj, key);
    // Only primitives count: in ECS logs "service" is an object and the value lives at "service.name".
    if (value !== undefined && value !== null && value !== '' && typeof value !== 'object') {
      used.add(key);
      return value;
    }
  }
  return undefined;
}

/**
 * Copy of `obj` without the picked keys. A nested pick ("log.level") removes only that leaf,
 * so siblings such as log.logger stay in metadata; parents left empty are dropped.
 */
function withoutKeys(obj: Record<string, unknown>, keys: Set<string>): Record<string, unknown> {
  const copy: Record<string, unknown> = structuredClone(obj);
  for (const key of keys) {
    if (key in copy) {
      delete copy[key];
      continue;
    }
    const parts = key.split('.');
    const leaf = parts.pop()!;
    const parents: Array<Record<string, unknown>> = [copy];
    for (const part of parts) parents.push(parents[parents.length - 1][part] as Record<string, unknown>);
    delete parents[parents.length - 1][leaf];
    for (let i = parts.length - 1; i >= 0; i--) {
      const child = parents[i + 1];
      if (Object.keys(child).length === 0) delete parents[i][parts[i]];
    }
  }
  return copy;
}

const asString =(v: unknown): string | undefined =>
  v === undefined ? undefined : typeof v === 'string' ? v : String(v);

export function parseJsonLines(
  content: string,
  sourceFile: string,
): { records: RawRecord[]; warnings: ParseWarning[] } {
  const records: RawRecord[] = [];
  const warnings: ParseWarning[] = [];

  content.split(/\r?\n/).forEach((line, idx) => {
    const sourceLine = idx + 1;
    if (line.trim() === '') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push({ sourceFile, sourceLine, reason: 'Invalid JSON' });
      return;
    }
    const result = jsonLine.safeParse(parsed);
    if (!result.success) {
      warnings.push({ sourceFile, sourceLine, reason: 'JSON line is not an object' });
      return;
    }

    const obj = result.data;
    const used = new Set<string>();
    const timestamp = pick(obj, TIMESTAMP_KEYS, used);
    const level = pick(obj, LEVEL_KEYS, used);
    const message = asString(pick(obj, MESSAGE_KEYS, used)) ?? '';
    const service = asString(pick(obj, SERVICE_KEYS, used));
    const traceId = asString(pick(obj, TRACE_KEYS, used));
    const requestId = asString(pick(obj, REQUEST_KEYS, used));

    const metadata = withoutKeys(obj, used);

    records.push({ sourceFile, sourceLine, timestamp, level, message, service, traceId, requestId, metadata });
  });

  return { records, warnings };
}
