import type { Level, LogEvent, RawRecord } from '../types.js';

/** Single source of truth for level names; the text parser builds its level regex from these keys. */
export const LEVEL_ALIASES: Record<string, Level> = {
  trace: 'TRACE',
  trc: 'TRACE',
  debug: 'DEBUG',
  dbg: 'DEBUG',
  fine: 'DEBUG',
  info: 'INFO',
  information: 'INFO',
  notice: 'INFO',
  warn: 'WARN',
  warning: 'WARN',
  error: 'ERROR',
  err: 'ERROR',
  severe: 'ERROR',
  fatal: 'FATAL',
  critical: 'FATAL',
  crit: 'FATAL',
  alert: 'FATAL',
  emerg: 'FATAL',
  emergency: 'FATAL',
  panic: 'FATAL',
};

// pino/bunyan numeric levels
const NUMERIC_LEVELS: Array<[number, Level]> = [
  [60, 'FATAL'],
  [50, 'ERROR'],
  [40, 'WARN'],
  [30, 'INFO'],
  [20, 'DEBUG'],
  [0, 'TRACE'],
];

export function normalizeLevel(raw: unknown): Level {
  if (typeof raw === 'number') return NUMERIC_LEVELS.find(([min]) => raw >= min)?.[1] ?? 'INFO';
  if (typeof raw === 'string') return LEVEL_ALIASES[raw.trim().toLowerCase()] ?? 'INFO';
  return 'INFO';
}

// Accept 1970..2200; anything outside is almost certainly a unit or parsing mistake.
const MAX_EPOCH_MS = Date.UTC(2200, 0, 1);

/** Returns epoch milliseconds, or null if unparseable. Timestamps without a zone are assumed UTC. */
export function normalizeTimestamp(raw: unknown): number | null {
  let ms: number;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    // Infer the unit from magnitude: seconds, milliseconds, microseconds, nanoseconds (OTel).
    ms = raw < 1e11 ? raw * 1000 : raw < 1e14 ? raw : raw < 1e17 ? raw / 1e3 : raw / 1e6;
    ms = Math.round(ms);
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    let s = raw.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return normalizeTimestamp(Number(s));
    // Only rewrite ISO-like strings ("2026-11-10 08:00:00,123"); leave RFC 2822 etc. to Date.parse.
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      s = s.replace(' ', 'T').replace(/(:\d{2}),(\d)/, '$1.$2');
      // JS Date only keeps milliseconds; trim extra fractional digits so parsing succeeds.
      s = s.replace(/(\.\d{3})\d+/, '$1');
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s)) s += 'Z';
    }
    ms = Date.parse(s);
  } else {
    return null;
  }
  return Number.isNaN(ms) || ms < 0 || ms > MAX_EPOCH_MS ? null : ms;
}

// Values some tracers emit when no real ID exists; treating them as IDs would merge unrelated events.
const PLACEHOLDER_ID = /^(0+|-+|null|nil|none|undefined|unknown|n\/a)?$/i;

export function normalizeCorrelationId(raw: string | undefined): string | undefined {
  const id = raw?.trim();
  return id && !PLACEHOLDER_ID.test(id) ? id : undefined;
}

/** "order-service.jsonl" -> "order-service"; "logs/api.2026-11-10.log" -> "api" */
export function serviceFromFilename(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const name = base.split('.')[0];
  return name || base;
}

export function normalizeRecord(raw: RawRecord): LogEvent | { error: string } {
  const epochMs = normalizeTimestamp(raw.timestamp);
  if (epochMs === null) return { error: `Missing or invalid timestamp: ${JSON.stringify(raw.timestamp)}` };

  return {
    id: `${raw.sourceFile}#${raw.sourceLine}`,
    timestamp: new Date(epochMs).toISOString(),
    epochMs,
    service: raw.service?.trim() || serviceFromFilename(raw.sourceFile),
    level: normalizeLevel(raw.level),
    message: raw.message,
    traceId: normalizeCorrelationId(raw.traceId),
    requestId: normalizeCorrelationId(raw.requestId),
    sourceFile: raw.sourceFile,
    sourceLine: raw.sourceLine,
    metadata: raw.metadata,
  };
}
