import type { AnalysisResult } from './api';

/**
 * One analysis = one current batch of files. The result always belongs to the batch on screen:
 * any change to the batch discards the previous result, and Analyze must be pressed again.
 */
export interface Workspace {
  files: File[];
  result: AnalysisResult | null;
  selected: string | null;
  error: string | null;
}

export const initialWorkspace: Workspace = { files: [], result: null, selected: null, error: null };

export type WorkspaceAction =
  | { type: 'addFiles'; files: File[] }
  | { type: 'removeFile'; name: string }
  | { type: 'clear' }
  // `batch` is the files array the request was made for; a response for an older batch is ignored.
  | { type: 'analyzed'; batch: File[]; result: AnalysisResult }
  | { type: 'failed'; batch: File[]; error: string }
  | { type: 'select'; id: string };

export function workspaceReducer(state: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case 'addFiles': {
      if (action.files.length === 0) return state;
      // Same name replaces: the filename is the service name, so duplicates would be ambiguous.
      const names = new Set(action.files.map((f) => f.name));
      return { ...initialWorkspace, files: [...state.files.filter((f) => !names.has(f.name)), ...action.files] };
    }
    case 'removeFile': {
      const files = state.files.filter((f) => f.name !== action.name);
      return files.length === state.files.length ? state : { ...initialWorkspace, files };
    }
    case 'clear':
      return initialWorkspace;
    case 'analyzed':
      if (action.batch !== state.files) return state;
      return { ...state, result: action.result, selected: action.result.incidents[0]?.id ?? null, error: null };
    case 'failed':
      if (action.batch !== state.files) return state;
      return { ...state, result: null, selected: null, error: action.error };
    case 'select':
      return { ...state, selected: action.id };
  }
}
