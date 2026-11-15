// Type-only import: the API contract lives in one place (server), erased at build time.
import type { AnalysisResult } from '../../server/src/types';

export type * from '../../server/src/types';

export interface Options {
  windowMs: number;
  minConfidence: number;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return body.error ?? `Request failed (${res.status})`;
}

export async function analyzeFiles(files: File[], options: Options): Promise<AnalysisResult> {
  const form = new FormData();
  form.append('windowMs', String(options.windowMs));
  form.append('minConfidence', String(options.minConfidence));
  for (const file of files) form.append('files', file, file.name);
  const res = await fetch('/api/analyze', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

/** Fetch the bundled samples as ordinary File objects, so they join the batch like an upload. */
export async function loadSampleFiles(): Promise<File[]> {
  const listRes = await fetch('/api/samples');
  if (!listRes.ok) throw new Error(await errorMessage(listRes));
  const names: string[] = await listRes.json();
  return Promise.all(
    names.map(async (name) => {
      const res = await fetch(`/api/samples/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      return new File([await res.text()], name, { type: 'text/plain' });
    }),
  );
}
