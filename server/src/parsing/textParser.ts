import type { ParseWarning, RawRecord } from '../types.js';
import { LEVEL_ALIASES } from './normalize.js';

/**
 * Supported text format (log4j/logback-like):
 *   <timestamp> <LEVEL> [logger]? <message with optional key=value pairs>
 * e.g. 2026-11-10T08:15:02.123Z ERROR [http] upstream failed path=/api/orders status=503 trace_id=abc
 * Timestamp may use 'T' or a space, '.' or ',' for fractions, and an optional zone.
 */
const LEVEL_NAMES = Object.keys(LEVEL_ALIASES).sort((a, b) => b.length - a.length).join('|');
const LINE_RE = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,9})?(?:Z|[+-]\\d{2}:?\\d{2})?)\\s+\\[?(${LEVEL_NAMES})\\]?\\s+(?:\\[([^\\]]*)\\]\\s+)?(.*)$`,
  'i',
);

// Key must start a token and is length-bounded, so matching stays linear on long lines
// (an unbounded `[\w.-]*=` rescans to the end of the line from every position).
const KV_RE = /(?<![\w.-])([A-Za-z_][\w.-]{0,63})=("([^"]*)"|[^\s,]+)/g;

/** Longer lines are truncated before regex work; keeps per-line cost bounded. */
export const MAX_LINE_CHARS = 16_384;

const TRACE_KEYS = new Set(['trace_id', 'traceid', 'trace', 'traceId']);
const REQUEST_KEYS = new Set(['request_id', 'requestid', 'requestId', 'req_id', 'reqid', 'rid', 'correlation_id']);

export function parseTextLines(
  content: string,
  sourceFile: string,
): { records: RawRecord[]; warnings: ParseWarning[] } {
  const records: RawRecord[] = [];
  const warnings: ParseWarning[] = [];

  content.split(/\r?\n/).forEach((fullLine, idx) => {
    const sourceLine = idx + 1;
    if (fullLine.trim() === '') return;
    const line = fullLine.length > MAX_LINE_CHARS ? fullLine.slice(0, MAX_LINE_CHARS) : fullLine;

    const m = LINE_RE.exec(line);
    if (!m) {
      // Lines without a timestamp prefix (stack traces, wrapped messages) belong to the previous event.
      const prev = records[records.length - 1];
      if (prev) {
        const cont = (prev.metadata.continuation as string[] | undefined) ?? [];
        cont.push(line);
        prev.metadata.continuation = cont;
      } else {
        warnings.push({ sourceFile, sourceLine, reason: 'Unrecognized text line before any log entry' });
      }
      return;
    }

    const [, timestamp, level, logger, message] = m;
    const metadata: Record<string, unknown> = {};
    if (logger) metadata.logger = logger;

    let traceId: string | undefined;
    let requestId: string | undefined;
    for (const kv of message.matchAll(KV_RE)) {
      const key = kv[1];
      const value = kv[3] ?? kv[2];
      if (TRACE_KEYS.has(key) || TRACE_KEYS.has(key.toLowerCase())) traceId = value;
      else if (REQUEST_KEYS.has(key) || REQUEST_KEYS.has(key.toLowerCase())) requestId = value;
      else metadata[key] = value;
    }

    records.push({ sourceFile, sourceLine, timestamp, level, message: message.trim(), traceId, requestId, metadata });
  });

  return { records, warnings };
}
