import { useState, type DragEvent } from 'react';
import { analyzeFiles, analyzeSamples, type AnalysisResult, type Incident, type Membership, type Options } from './api';

const SERVICE_COLORS = ['#2a78d6', '#1baa7a', '#9a5bd8', '#e0812b', '#d84a7a', '#3b9fb5', '#8a8f2d'];

function serviceColor(service: string, services: string[]): string {
  const idx = services.indexOf(service);
  return SERVICE_COLORS[(idx < 0 ? 0 : idx) % SERVICE_COLORS.length];
}

const time = (iso: string) => iso.slice(11, 23);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function CorrelationBadge({ incident }: { incident: Incident }) {
  if (incident.correlation === 'exact') return <span className="badge exact">exact</span>;
  if (incident.correlation === 'isolated') return <span className="badge isolated">single event</span>;
  return (
    <span className="badge heuristic" title="Weakest inferred link in this incident">
      heuristic · min {pct(incident.confidence ?? 0)}
    </span>
  );
}

function MembershipCell({ m }: { m: Membership }) {
  if (m.kind === 'seed') return <span className="badge isolated">anchor</span>;
  if (m.kind === 'exact') return <span className="badge exact">exact · {m.key}</span>;
  return (
    <details className="membership">
      <summary>
        <span className="badge heuristic">heuristic · {pct(m.confidence)}</span>
        {m.key && <span className="badge exact subtle">{m.key}</span>}
      </summary>
      <div className="reasons">
        matched <code>{m.matchedEventId}</code>
        <ul>
          {m.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function IncidentDetail({ incident, services }: { incident: Incident; services: string[] }) {
  return (
    <section className="detail">
      <header>
        <h2>
          {incident.id} <span className={`level ${incident.severity}`}>{incident.severity}</span>
        </h2>
        <p className="title">{incident.title}</p>
        <p className="muted">
          {incident.start.replace('T', ' ').slice(0, 23)} → {time(incident.end)} UTC · {incident.timeline.length} events ·{' '}
          <CorrelationBadge incident={incident} />
        </p>
        {incident.correlation === 'heuristic' && (
          <p className="notice">
            Part of this incident was grouped by heuristics (time proximity and shared signals), not by a shared
            trace/request ID. Treat heuristic links as hypotheses to verify.
          </p>
        )}
      </header>
      <table className="timeline">
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Service</th>
            <th>Level</th>
            <th>Message</th>
            <th>Correlation</th>
          </tr>
        </thead>
        <tbody>
          {incident.timeline.map(({ event, membership }) => (
            <tr key={event.id} className={`row-${event.level}`}>
              <td className="mono">{time(event.timestamp)}</td>
              <td>
                <span className="service" style={{ borderColor: serviceColor(event.service, services) }}>
                  {event.service}
                </span>
              </td>
              <td>
                <span className={`level ${event.level}`}>{event.level}</span>
              </td>
              <td className="message">
                {event.message}
                <div className="source">
                  {event.sourceFile}:{event.sourceLine}
                </div>
              </td>
              <td>
                <MembershipCell m={membership} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [options, setOptions] = useState<Options>({ windowMs: 5000, minConfidence: 0.5 });
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => [...prev.filter((p) => !incoming.some((f) => f.name === p.name)), ...incoming]);
  };

  const run = async (fn: () => Promise<AnalysisResult>) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fn();
      setResult(r);
      setSelected(r.incidents[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const services = result ? [...new Set(result.incidents.flatMap((i) => i.services))].sort() : [];
  const current = result?.incidents.find((i) => i.id === selected);

  return (
    <div className="app">
      <header className="top">
        <h1>Incident Lens</h1>
        <p className="muted">Upload logs from several services to correlate them into incident timelines.</p>
      </header>

      <section className="upload">
        <label
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input type="file" multiple onChange={(e) => addFiles(e.target.files)} />
          <strong>Drop log files here</strong> or click to choose · NDJSON or text · filename = service name
        </label>

        {files.length > 0 && (
          <ul className="files">
            {files.map((f) => (
              <li key={f.name}>
                {f.name} <span className="muted">({(f.size / 1024).toFixed(1)} KB)</span>
                <button className="link" onClick={() => setFiles(files.filter((x) => x !== f))}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="controls">
          <label>
            Time window (ms)
            <input
              type="number"
              min={100}
              step={500}
              value={options.windowMs}
              onChange={(e) => setOptions({ ...options, windowMs: Number(e.target.value) })}
            />
          </label>
          <label>
            Min heuristic confidence
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={options.minConfidence}
              onChange={(e) => setOptions({ ...options, minConfidence: Number(e.target.value) })}
            />
          </label>
          <button className="primary" disabled={loading || files.length === 0} onClick={() => run(() => analyzeFiles(files, options))}>
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
          <button disabled={loading} onClick={() => run(() => analyzeSamples(options))}>
            Analyze sample logs
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <section className="summary">
            <span>
              <b>{result.files.length}</b> files
            </span>
            <span>
              <b>{result.totalEvents}</b> events
            </span>
            <span>
              <b>{result.incidents.length}</b> incidents
            </span>
            <span>
              <b>{result.eventsInIncidents}</b> events in incidents
            </span>
            {result.warnings.length > 0 && (
              <details>
                <summary>
                  <b>{result.warnings.length}</b> parse warnings
                </summary>
                <ul>
                  {result.warnings.map((w) => (
                    <li key={`${w.sourceFile}:${w.sourceLine}`}>
                      {w.sourceFile}:{w.sourceLine} — {w.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <span className="muted">
              {result.files.map((f) => `${f.name} (${f.format})`).join(', ')}
            </span>
          </section>

          {result.incidents.length === 0 ? (
            <p className="muted">No incidents found (no ERROR/FATAL events).</p>
          ) : (
            <div className="results">
              <nav className="incidents">
                {result.incidents.map((inc) => (
                  <button
                    key={inc.id}
                    className={`incident ${inc.id === selected ? 'active' : ''}`}
                    onClick={() => setSelected(inc.id)}
                  >
                    <div className="row">
                      <b>{inc.id}</b>
                      <span className={`level ${inc.severity}`}>{inc.severity}</span>
                      <CorrelationBadge incident={inc} />
                    </div>
                    <div className="title">{inc.title}</div>
                    <div className="muted small">
                      {time(inc.start)} · {inc.services.join(', ')}
                    </div>
                  </button>
                ))}
              </nav>
              {current && <IncidentDetail incident={current} services={services} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
