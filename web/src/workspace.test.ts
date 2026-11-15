import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from './api';
import { initialWorkspace, workspaceReducer as reduce, type Workspace } from './workspace';

const file = (name: string, content = 'x') => new File([content], name);

const result = (ids: string[]): AnalysisResult =>
  ({
    options: { windowMs: 5000, minConfidence: 0.5 },
    files: [],
    totalEvents: 0,
    eventsInIncidents: 0,
    incidents: ids.map((id) => ({ id })),
    warnings: [],
  }) as unknown as AnalysisResult;

function analyzedWorkspace(): Workspace {
  const withFiles = reduce(initialWorkspace, { type: 'addFiles', files: [file('a.log'), file('b.log')] });
  return reduce(withFiles, { type: 'analyzed', batch: withFiles.files, result: result(['INC-001', 'INC-002']) });
}

describe('workspace reducer', () => {
  it('adds files and replaces files with the same name', () => {
    const s1 = reduce(initialWorkspace, { type: 'addFiles', files: [file('a.log', 'old'), file('b.log')] });
    const replacement = file('a.log', 'new');
    const s2 = reduce(s1, { type: 'addFiles', files: [replacement] });
    expect(s2.files.map((f) => f.name)).toEqual(['b.log', 'a.log']);
    expect(s2.files[1]).toBe(replacement);
  });

  it('stores a result for the current batch and selects the first incident', () => {
    const s = analyzedWorkspace();
    expect(s.result).not.toBeNull();
    expect(s.selected).toBe('INC-001');
  });

  it('clears the old result when a file is added after analysis', () => {
    const s = reduce(analyzedWorkspace(), { type: 'addFiles', files: [file('c.log')] });
    expect(s.files).toHaveLength(3);
    expect(s.result).toBeNull();
    expect(s.selected).toBeNull();
  });

  it('clears the old result when a file is removed after analysis', () => {
    const s = reduce(analyzedWorkspace(), { type: 'removeFile', name: 'a.log' });
    expect(s.files.map((f) => f.name)).toEqual(['b.log']);
    expect(s.result).toBeNull();
  });

  it('clears an error when the batch changes', () => {
    const withFiles = reduce(initialWorkspace, { type: 'addFiles', files: [file('a.log')] });
    const failed = reduce(withFiles, { type: 'failed', batch: withFiles.files, error: 'boom' });
    expect(failed.error).toBe('boom');
    expect(reduce(failed, { type: 'addFiles', files: [file('b.log')] }).error).toBeNull();
  });

  it('clear resets to the initial state', () => {
    expect(reduce(analyzedWorkspace(), { type: 'clear' })).toEqual(initialWorkspace);
  });

  it('ignores a response that arrives for a batch that has since changed', () => {
    const s1 = reduce(initialWorkspace, { type: 'addFiles', files: [file('a.log')] });
    const requestedFor = s1.files;
    const s2 = reduce(s1, { type: 'addFiles', files: [file('b.log')] }); // user edits while request in flight
    expect(reduce(s2, { type: 'analyzed', batch: requestedFor, result: result(['INC-001']) }).result).toBeNull();
    expect(reduce(s2, { type: 'failed', batch: requestedFor, error: 'late' }).error).toBeNull();
  });

  it('removing an unknown file is a no-op that keeps the result', () => {
    const s = analyzedWorkspace();
    expect(reduce(s, { type: 'removeFile', name: 'zzz.log' })).toBe(s);
  });
});
