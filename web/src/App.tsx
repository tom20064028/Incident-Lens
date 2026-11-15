import { useReducer, useState, type DragEvent } from 'react';
import { analyzeFiles, loadSampleFiles, type Incident, type Membership, type Options } from './api';
import { initialWorkspace, workspaceReducer } from './workspace';

const SERVICE_COLORS = ['#2a78d6', '#1baa7a', '#9a5bd8', '#e0812b', '#d84a7a', '#3b9fb5', '#8a8f2d'];

function serviceColor(service: string, services: string[]): string {
  const idx = services.indexOf(service);
  return SERVICE_COLORS[(idx < 0 ? 0 : idx) % SERVICE_COLORS.length];
}

const time = (iso: string) => iso.slice(11, 23);
const score = (n: number) => n.toFixed(2);

function CorrelationBadge({ incident }: { incident: Incident }) {
  if (incident.correlation === 'exact') return <span className="badge exact">exact</span>;
  if (incident.correlation === 'isolated') return <span className="badge isolated">single event</span>;
  return (
    <span className="badge heuristic" title="Weakest inferred link in this incident (evidence score, not a probability)">
      heuristic · min score {score(incident.confidence ?? 0)}
    </span>
  );
}

function MembershipCell({ m }: { m: Membership }) {
  if (m.kind === 'seed') return <span className="badge isolated">anchor</span>;
  if (m.kind === 'exact') return <span className="badge exact">exact · {m.key}</span>;
  return (
    <details className="membership">
      <summary>
        <span className="badge heuristic">heuristic · score {score(m.confidence)}</span>
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
  const [{ files, result, selected, error }, dispatch] = useReducer(workspaceReducer, initialWorkspace);
  const [options, setOptions] = useState<Options>({ windowMs: 5000, minConfidence: 0.5 });
  const [busy, setBusy] = useState<'analyzing' | 'loading-samples' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const addFiles = (list: FileList | File[] | null) => {
    setLoadError(null);
    if (list) dispatch({ type: 'addFiles', files: Array.from(list) });
  };

  const loadSamples = async () => {
    setBusy('loading-samples');
    setLoadError(null);
    try {
      dispatch({ type: 'addFiles', files: await loadSampleFiles() });
    } catch (e) {
      setLoadError(`Could not load sample logs: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const analyze = async () => {
    const batch = files;
    setBusy('analyzing');
    try {
      dispatch({ type: 'analyzed', batch, result: await analyzeFiles(batch, options) });
    } catch (e) {
      dispatch({ type: 'failed', batch, error: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const clear = () => {
    setLoadError(null);
    dispatch({ type: 'clear' });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const services = result ? [...new Set(result.incidents.flatMap((i) => i.services))].sort() : [];
  const current = result?.incidents.find((i) => i.id === selected);
  const shownError = loadError ?? error;

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
          <input
            type="file"
            multiple
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = ''; // allow choosing the same file again after removing it
            }}
          />
          <strong>Drop log files here</strong> or click to choose · NDJSON or text · filename = service name
        </label>

        <div className="batch-header">
          <span className="muted small">
            {files.length === 0 ? 'No files in this analysis yet.' : `Current analysis: ${files.length} file${files.length === 1 ? '' : 's'}`}
          </span>
          <button className="link" disabled={busy !== null} onClick={loadSamples}>
            {busy === 'loading-samples' ? 'Loading samples…' : 'Load sample logs'}
          </button>
        </div>

        {files.length > 0 && (
          <ul className="files">
            {files.map((f) => (
              <li key={f.name}>
                {f.name} <span className="muted">({(f.size / 1024).toFixed(1)} KB)</span>
                <button className="link" onClick={() => dispatch({ type: 'removeFile', name: f.name })}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <details className="advanced">
          <summary>Advanced settings</summary>
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
              Minimum heuristic score
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={options.minConfidence}
                onChange={(e) => setOptions({ ...options, minConfidence: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="muted small">
            Heuristic score is a hand-tuned evidence score, not a probability. Press Analyze again after changing these.
          </p>
        </details>

        <div className="controls">
          <button className="primary" disabled={busy !== null || files.length === 0} onClick={analyze}>
            {busy === 'analyzing' ? 'Analyzing…' : 'Analyze'}
          </button>
          <button disabled={busy !== null || (files.length === 0 && !result && !shownError)} onClick={clear}>
            Clear files
          </button>
        </div>
        {shownError && <p className="error">{shownError}</p>}
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
                    onClick={() => dispatch({ type: 'select', id: inc.id })}
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
