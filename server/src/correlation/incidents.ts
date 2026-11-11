import {
  isAtLeast,
  levelRank,
  type HeuristicLink,
  type Incident,
  type LogEvent,
  type Membership,
  type TimelineEntry,
} from '../types.js';
import { extractFeatures, type EventFeatures } from './features.js';
import { scorePair, type HeuristicScore } from './heuristic.js';

export interface CorrelateOptions {
  windowMs: number;
  minConfidence: number;
}

const MAX_NEIGHBORS = 50;

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

interface Group {
  members: number[]; // indices into the time-sorted event array
  keys: Set<string>;
}

interface Edge {
  ga: number;
  gb: number;
  ea: number; // event in ga
  eb: number; // event in gb
  score: HeuristicScore;
}

const byTime = (a: LogEvent, b: LogEvent) =>
  a.epochMs - b.epochMs || a.sourceFile.localeCompare(b.sourceFile) || a.sourceLine - b.sourceLine;

function eventKeys(e: LogEvent): string[] {
  const keys: string[] = [];
  if (e.traceId) keys.push(`traceId=${e.traceId}`);
  if (e.requestId) keys.push(`requestId=${e.requestId}`);
  return keys;
}

/**
 * Pipeline:
 *  1. Exact: union events that share a traceId or requestId into groups.
 *  2. Heuristic: score pairs of WARN+ events (at least one ERROR+) from different groups inside
 *     the time window; keep the best-scoring pair per group pair if it reaches minConfidence.
 *     Each event is compared with at most MAX_NEIGHBORS following events, which bounds the work
 *     at O(n * MAX_NEIGHBORS) even when thousands of errors share a timestamp.
 *  3. Groups connected by heuristic edges form a candidate incident; it is kept if it has an
 *     ERROR/FATAL event.
 *  4. Within an incident, groups are attached to the anchor (the group with the earliest error)
 *     strongest-link-first, so each heuristic membership reports the single link that justified it.
 */
export function correlate(input: LogEvent[], options: CorrelateOptions): Incident[] {
  const events = [...input].sort(byTime);

  // 1. Exact grouping
  const uf = new UnionFind(events.length);
  const firstByKey = new Map<string, number>();
  events.forEach((e, i) => {
    for (const key of eventKeys(e)) {
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, i);
      else uf.union(i, first);
    }
  });

  const groupIndexByRoot = new Map<number, number>();
  const groups: Group[] = [];
  const groupOf: number[] = [];
  events.forEach((e, i) => {
    const root = uf.find(i);
    let g = groupIndexByRoot.get(root);
    if (g === undefined) {
      g = groups.length;
      groupIndexByRoot.set(root, g);
      groups.push({ members: [], keys: new Set() });
    }
    groups[g].members.push(i);
    eventKeys(e).forEach((k) => groups[g!].keys.add(k));
    groupOf[i] = g;
  });

  // 2. Heuristic edges between groups
  const candidates = events.map((_, i) => i).filter((i) => isAtLeast(events[i].level, 'WARN'));
  const features = new Map<number, EventFeatures>();
  const featuresOf = (i: number) => {
    let f = features.get(i);
    if (!f) features.set(i, (f = extractFeatures(events[i])));
    return f;
  };

  const bestEdge = new Map<string, Edge>();
  for (let x = 0; x < candidates.length; x++) {
    const i = candidates[x];
    for (let y = x + 1; y < candidates.length && y <= x + MAX_NEIGHBORS; y++) {
      const j = candidates[y];
      if (events[j].epochMs - events[i].epochMs > options.windowMs) break; // sorted by time
      const gi = groupOf[i];
      const gj = groupOf[j];
      if (gi === gj) continue;
      const score = scorePair(events[i], featuresOf(i), events[j], featuresOf(j), options.windowMs);
      if (!score || score.confidence < options.minConfidence) continue;
      const pairKey = gi < gj ? `${gi}:${gj}` : `${gj}:${gi}`;
      const existing = bestEdge.get(pairKey);
      if (!existing || score.confidence > existing.score.confidence) {
        bestEdge.set(pairKey, { ga: gi, gb: gj, ea: i, eb: j, score });
      }
    }
  }

  // 3. Connected components of groups
  const guf = new UnionFind(groups.length);
  const adjacency = new Map<number, Edge[]>();
  for (const edge of bestEdge.values()) {
    guf.union(edge.ga, edge.gb);
    for (const g of [edge.ga, edge.gb]) {
      const list = adjacency.get(g);
      if (list) list.push(edge);
      else adjacency.set(g, [edge]);
    }
  }
  const components = new Map<number, number[]>();
  groups.forEach((_, g) => {
    const root = guf.find(g);
    const list = components.get(root);
    if (list) list.push(g);
    else components.set(root, [g]);
  });

  // 4. Build incidents
  const incidents: Omit<Incident, 'id'>[] = [];
  for (const componentGroups of components.values()) {
    const memberEvents = componentGroups.flatMap((g) => groups[g].members).sort((a, b) => a - b);
    const firstError = memberEvents.find((i) => isAtLeast(events[i].level, 'ERROR'));
    if (firstError === undefined) continue;

    const anchor = groupOf[firstError];
    const membershipByGroup = new Map<number, Membership | 'anchor'>([[anchor, 'anchor']]);
    const links: HeuristicLink[] = [];

    // Strongest-link-first expansion from the anchor (Prim's algorithm on max confidence).
    // `frontier` holds the best known edge into each not-yet-attached group, updated incrementally.
    const frontier = new Map<number, { edge: Edge; inside: number }>();
    const expand = (g: number) => {
      for (const edge of adjacency.get(g) ?? []) {
        const other = edge.ga === g ? edge.gb : edge.ga;
        if (membershipByGroup.has(other)) continue;
        const current = frontier.get(other);
        if (!current || edge.score.confidence > current.edge.score.confidence) frontier.set(other, { edge, inside: g });
      }
    };
    expand(anchor);
    while (frontier.size > 0) {
      let outside = -1;
      let pick: { edge: Edge; inside: number } | undefined;
      for (const [g, candidate] of frontier) {
        if (!pick || candidate.edge.score.confidence > pick.edge.score.confidence) {
          pick = candidate;
          outside = g;
        }
      }
      frontier.delete(outside);
      const { edge, inside } = pick!;
      const insideEvent = edge.ga === inside ? edge.ea : edge.eb;
      const outsideEvent = edge.ga === inside ? edge.eb : edge.ea;
      membershipByGroup.set(outside, {
        kind: 'heuristic',
        confidence: edge.score.confidence,
        reasons: edge.score.reasons,
        matchedEventId: events[insideEvent].id,
      });
      links.push({
        fromEventId: events[insideEvent].id,
        toEventId: events[outsideEvent].id,
        confidence: edge.score.confidence,
        reasons: edge.score.reasons,
      });
      expand(outside);
    }

    const timeline: TimelineEntry[] = memberEvents.map((i) => {
      const e = events[i];
      const g = groupOf[i];
      const ownKey = eventKeys(e)[0];
      const groupMembership = membershipByGroup.get(g)!;
      let membership: Membership;
      if (groupMembership === 'anchor') {
        membership = groups[g].members.length > 1 && ownKey ? { kind: 'exact', key: ownKey } : { kind: 'seed' };
      } else if (groupMembership.kind === 'heuristic' && groups[g].members.length > 1 && ownKey) {
        membership = { ...groupMembership, key: ownKey };
      } else {
        membership = groupMembership;
      }
      return { event: e, membership };
    });

    const timelineEvents = timeline.map((t) => t.event);
    const severity = timelineEvents.reduce(
      (max, e) => (levelRank(e.level) > levelRank(max) ? e.level : max),
      timelineEvents[0].level,
    );
    const title = events[firstError].message;

    incidents.push({
      title: title.length > 140 ? `${title.slice(0, 137)}...` : title,
      severity,
      start: timelineEvents[0].timestamp,
      end: timelineEvents[timelineEvents.length - 1].timestamp,
      services: [...new Set(timelineEvents.map((e) => e.service))],
      correlation: links.length ? 'heuristic' : timeline.length > 1 ? 'exact' : 'isolated',
      confidence: links.length ? Math.min(...links.map((l) => l.confidence)) : null,
      correlationKeys: [...new Set(componentGroups.flatMap((g) => [...groups[g].keys]))].sort(),
      heuristicLinks: links,
      timeline,
    });
  }

  return incidents
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((incident, n) => ({ id: `INC-${String(n + 1).padStart(3, '0')}`, ...incident }));
}
