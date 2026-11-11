import type { LogEvent } from '../types.js';

/** Signals extracted from one event that heuristic correlation compares across events. */
export interface EventFeatures {
  paths: Set<string>;
  codes: Set<string>;
  keywords: Set<string>;
}

const MAX_FEATURE_CHARS = 4096;
const PATH_KEYS =['path', 'endpoint', 'route', 'url', 'uri'];
const STATUS_KEYS = ['status', 'statusCode', 'status_code', 'http_status', 'httpStatus'];
const CODE_KEYS = ['code', 'errorCode', 'error_code', 'err_code'];

const PATH_RE = /(?:^|[\s=("'])(\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-.{}:]+)*)/g;
const HTTP_STATUS_RE = /\b([45]\d\d)\b/g;
// SCREAMING_SNAKE codes (DB_CONN_TIMEOUT) and errno-style codes (ECONNREFUSED)
const ERROR_CODE_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|E[A-Z]{4,})\b/g;

// Generic words that appear in almost every error line and would create false matches.
const STOPWORDS = new Set(
  (
    'error errors failed failure fail exception warn warning info debug request requests response ' +
    'with from that this have been when while after before into could would should will unable ' +
    'service status code path true false null undefined message retry retrying attempt returned'
  ).split(' '),
);

export function normalizePath(raw: string): string {
  let p = raw.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0].toLowerCase();
  // Collapse IDs so /orders/123 and /orders/456 match.
  p = p.replace(/\/(\d+|[0-9a-f]{8,}|[0-9a-f-]{36})(?=\/|$)/g, '/:id');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

function metadataValue(event: LogEvent, keys: string[]): unknown {
  for (const key of keys) if (event.metadata[key] !== undefined) return event.metadata[key];
  return undefined;
}

export function extractFeatures(event: LogEvent): EventFeatures {
  const paths = new Set<string>();
  const codes = new Set<string>();
  const keywords = new Set<string>();

  // Bound regex work per event; signals beyond the first few KB of a message add little.
  const message = event.message.slice(0, MAX_FEATURE_CHARS);

  const metaPath = metadataValue(event, PATH_KEYS);
  if (typeof metaPath === 'string' && metaPath.includes('/')) paths.add(normalizePath(metaPath));
  for (const m of message.matchAll(PATH_RE)) paths.add(normalizePath(m[1]));

  const status = Number(metadataValue(event, STATUS_KEYS));
  if (status >= 400 && status < 600) codes.add(`http:${status}`);
  for (const m of message.matchAll(HTTP_STATUS_RE)) codes.add(`http:${m[1]}`);

  const code = metadataValue(event, CODE_KEYS);
  if (typeof code === 'string' && code) codes.add(code.toUpperCase());
  for (const m of message.matchAll(ERROR_CODE_RE)) codes.add(m[1]);

  // Keywords: free-text words only (drop key=value pairs, paths, numbers and IDs).
  const text = message.replace(/(?<![\w.-])[A-Za-z_][\w.-]{0,63}=("[^"]*"|\S+)/g, ' ').replace(/\/\S*/g, ' ');
  for (const word of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    if (word.length >= 4 && !STOPWORDS.has(word) && !/\d/.test(word)) keywords.add(word);
  }

  return { paths, codes, keywords };
}
