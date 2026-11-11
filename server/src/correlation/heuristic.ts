import { isAtLeast, type LogEvent } from '../types.js';
import type { EventFeatures } from './features.js';

/**
 * Weights sum to 1.0. Time proximity + severity + service mention max out at 0.45, which is
 * below the default 0.5 threshold on purpose: two events are never linked just for being
 * close in time; they also need a shared endpoint, error code, or keywords.
 */
export const WEIGHTS = {
  time: 0.3,
  path: 0.2,
  code: 0.2,
  keywords: 0.15,
  service: 0.1,
  severity: 0.05,
} as const;

export interface HeuristicScore {
  confidence: number;
  reasons: string[];
}

const intersect = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((x) => b.has(x));

/** Does `text` mention `service` by full name or by its stem ("inventory-service" -> "inventory")? */
const servicePatterns = new Map<string, RegExp>();

export function mentionsService(text: string, service: string): boolean {
  let pattern = servicePatterns.get(service);
  if (!pattern) {
    const name = service.toLowerCase();
    const stem = name.replace(/[-_]?(service|svc|api|server)$/, '');
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const names = (stem.length >= 3 && stem !== name ? [name, stem] : [name]).map(escape).join('|');
    pattern = new RegExp(`(^|[^a-z0-9])(${names})([^a-z0-9]|$)`);
    servicePatterns.set(service, pattern);
  }
  return pattern.test(text.toLowerCase());
}

/**
 * Score how likely two events (without a shared correlation ID) are part of the same incident.
 * Returns null when they are outside the time window or the pair is not eligible.
 */
export function scorePair(
  a: LogEvent,
  fa: EventFeatures,
  b: LogEvent,
  fb: EventFeatures,
  windowMs: number,
): HeuristicScore | null {
  const dt = Math.abs(a.epochMs - b.epochMs);
  if (dt > windowMs) return null;
  if (!isAtLeast(a.level, 'ERROR') && !isAtLeast(b.level, 'ERROR')) return null;

  let score = 0;
  const reasons: string[] = [];

  score += WEIGHTS.time * (1 - dt / windowMs);
  reasons.push(`${dt} ms apart (window ${windowMs} ms)`);

  const paths = intersect(fa.paths, fb.paths);
  if (paths.length) {
    score += WEIGHTS.path;
    reasons.push(`shared endpoint ${paths.join(', ')}`);
  }

  const codes = intersect(fa.codes, fb.codes);
  if (codes.length) {
    score += WEIGHTS.code;
    reasons.push(`shared error code ${codes.join(', ')}`);
  }

  const words = intersect(fa.keywords, fb.keywords);
  if (words.length) {
    // Overlap coefficient rather than Jaccard: log lines differ in length a lot.
    const overlap = words.length / Math.min(fa.keywords.size, fb.keywords.size);
    score += WEIGHTS.keywords * Math.min(1, overlap * 2);
    reasons.push(`shared keywords: ${words.slice(0, 5).join(', ')}`);
  }

  if (a.service !== b.service) {
    if (mentionsService(a.message, b.service)) {
      score += WEIGHTS.service;
      reasons.push(`${a.service} log mentions ${b.service}`);
    } else if (mentionsService(b.message, a.service)) {
      score += WEIGHTS.service;
      reasons.push(`${b.service} log mentions ${a.service}`);
    }
  }

  if (isAtLeast(a.level, 'ERROR') && isAtLeast(b.level, 'ERROR')) {
    score += WEIGHTS.severity;
    reasons.push('both ERROR or above');
  }

  return { confidence: Math.round(score * 100) / 100, reasons };
}
