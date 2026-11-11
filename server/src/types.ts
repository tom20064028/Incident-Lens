export const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
export type Level = (typeof LEVELS)[number];

export const levelRank = (level: Level): number => LEVELS.indexOf(level);
export const isAtLeast = (level: Level, min: Level): boolean => levelRank(level) >= levelRank(min);

export type LogFormat = 'json' | 'text';

/** Format-specific parsers emit this; normalization turns it into a LogEvent. */
export interface RawRecord {
  sourceFile: string;
  sourceLine: number;
  timestamp: unknown;
  level: unknown;
  message: string;
  service?: string;
  traceId?: string;
  requestId?: string;
  metadata: Record<string, unknown>;
}

export interface LogEvent {
  id: string;
  timestamp: string; // ISO-8601, UTC
  epochMs: number;
  service: string;
  level: Level;
  message: string;
  traceId?: string;
  requestId?: string;
  sourceFile: string;
  sourceLine: number;
  metadata: Record<string, unknown>;
}

export interface ParseWarning {
  sourceFile: string;
  sourceLine: number;
  reason: string;
}

export interface InputFile {
  name: string;
  content: string;
}

/** How an event came to belong to its incident. */
export type Membership =
  | { kind: 'seed' } // lone anchor event with no correlation ID
  | { kind: 'exact'; key: string } // shares traceId/requestId with the anchor group
  | {
      kind: 'heuristic';
      confidence: number;
      reasons: string[];
      matchedEventId: string; // the event in the incident it was matched against
      key?: string; // set when the event is also exact-linked within its own group
    };

export interface TimelineEntry {
  event: LogEvent;
  membership: Membership;
}

export interface HeuristicLink {
  fromEventId: string;
  toEventId: string;
  confidence: number;
  reasons: string[];
}

export interface Incident {
  id: string;
  title: string;
  severity: Level;
  start: string;
  end: string;
  services: string[];
  /** exact: only ID-based links; heuristic: at least one inferred link; isolated: a single uncorrelated event */
  correlation: 'exact' | 'heuristic' | 'isolated';
  /** Weakest heuristic link in the incident, or null when no heuristic link was used. */
  confidence: number | null;
  correlationKeys: string[];
  heuristicLinks: HeuristicLink[];
  timeline: TimelineEntry[];
}

export interface FileSummary {
  name: string;
  format: LogFormat;
  events: number;
  warnings: number;
}

export interface AnalysisResult {
  options: { windowMs: number; minConfidence: number };
  files: FileSummary[];
  totalEvents: number;
  eventsInIncidents: number;
  incidents: Incident[];
  warnings: ParseWarning[];
}
