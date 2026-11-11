// Type-only import: the API contract lives in one place (server), erased at build time.
import type { AnalysisResult } from '../../server/src/types';

export type * from '../../server/src/types';

export interface Options {
  windowMs: number;
  minConfidence: number;
}

async function handle(res: Response): Promise<AnalysisResult> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as AnalysisResult;
}

export async function analyzeFiles(files: File[], options: Options): Promise<AnalysisResult> {
  const form = new FormData();
  form.append('windowMs', String(options.windowMs));
  form.append('minConfidence', String(options.minConfidence));
  for (const file of files) form.append('files', file, file.name);
  return handle(await fetch('/api/analyze', { method: 'POST', body: form }));
}

export async function analyzeSamples(options: Options): Promise<AnalysisResult> {
  const qs = new URLSearchParams({ windowMs: String(options.windowMs), minConfidence: String(options.minConfidence) });
  return handle(await fetch(`/api/analyze/samples?${qs}`, { method: 'POST' }));
}
