import type { LogFormat } from '../types.js';

const SAMPLE_LINES = 20;

/** Decide per file by sampling: if most leading non-empty lines are JSON objects, treat it as NDJSON. */
export function detectFormat(content: string): LogFormat {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, SAMPLE_LINES);
  if (lines.length === 0) return 'text';

  const jsonLines = lines.filter((line) => {
    if (!line.startsWith('{')) return false;
    try {
      const value = JSON.parse(line);
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    } catch {
      return false;
    }
  }).length;

  return jsonLines / lines.length >= 0.5 ? 'json' : 'text';
}
