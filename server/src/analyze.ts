import { z } from 'zod';
import { correlate } from './correlation/incidents.js';
import { parseFile } from './parsing/index.js';
import type { AnalysisResult, InputFile } from './types.js';

export const analysisOptionsSchema = z.object({
  windowMs: z.coerce.number().int().min(100).max(3_600_000).default(5000),
  minConfidence: z.coerce.number().min(0).max(1).default(0.5),
});
export type AnalysisOptions = z.infer<typeof analysisOptionsSchema>;

// Analysis runs synchronously on the request thread, so input size is capped to keep latency bounded.
export const MAX_EVENTS = 200_000;

export class AnalysisLimitError extends Error {
  readonly statusCode = 413;
}

/** Full pipeline: detect -> parse -> normalize -> correlate -> incidents/timeline. Pure and synchronous. */
export function analyze(files: InputFile[], rawOptions: unknown = {}): AnalysisResult {
  const options = analysisOptionsSchema.parse(rawOptions);
  const parsed = files.map(parseFile);
  const events = parsed.flatMap((p) => p.events);
  if (events.length > MAX_EVENTS) {
    throw new AnalysisLimitError(`Too many log events (${events.length}); the limit is ${MAX_EVENTS}.`);
  }
  const incidents = correlate(events, options);

  return {
    options,
    files: parsed.map((p) => ({ name: p.name, format: p.format, events: p.events.length, warnings: p.warnings.length })),
    totalEvents: events.length,
    eventsInIncidents: incidents.reduce((n, inc) => n + inc.timeline.length, 0),
    incidents,
    warnings: parsed.flatMap((p) => p.warnings),
  };
}
