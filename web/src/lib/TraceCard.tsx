import { useEffect, useState } from "react";

import type { TraceState } from "./useTraceJob";

function elapsed(startedAt: string, offsetMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() + offsetMs - Date.parse(startedAt)) / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "Time elapsed", counted from the server's started-at time with the server's clock. */
function Elapsed({ startedAt, offsetMs }: { startedAt: string; offsetMs: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="trace-card__elapsed">Time elapsed <strong>{elapsed(startedAt, offsetMs)}</strong></span>;
}

type Props = TraceState & {
  estimateMinutes: number | null;
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
};

/** "Create satin columns" card: loading, unavailable, idle, queued, running, done (collapsed), failed, cancelled. */
export function TraceCard({ phase, job, problem, clockOffsetMs, workers, estimateMinutes, onStart, onCancel, onRetry }: Props) {
  const estimate = estimateMinutes !== null && (phase === "idle" || phase === "queued" || phase === "running") && (
    <p className="trace-card__estimate">Usually about {estimateMinutes} minutes <span className="trace-card__tag">estimate</span></p>
  );
  const cancelButton = (
    <button className="btn btn--ghost btn--sm" type="button" onClick={onCancel} disabled={job?.cancel_requested}>
      {job?.cancel_requested ? "Cancelling…" : "Cancel job"}
    </button>
  );

  if (phase === "done" && job?.result) {
    const n = job.result.columns.length;
    return (
      <section className="trace-card trace-card--done" aria-label="Create satin columns" data-state="done">
        <div className="trace-card__head">
          <span className="trace-card__check" aria-hidden="true">✓</span>
          <h2 className="trace-card__title">Traced</h2>
          <span className="chip-beta">Beta</span>
        </div>
        <p className="trace-card__text">{n} satin {n === 1 ? "column" : "columns"} on the canvas, numbered, with edit points.</p>
      </section>
    );
  }

  return (
    <section className="trace-card" aria-label="Create satin columns" data-state={phase}>
      <div className="trace-card__head">
        <h2 className="trace-card__title">Create satin columns</h2>
        <span className="chip-beta">Beta</span>
      </div>

      {phase === "loading" && <p className="trace-card__text" role="status">Checking background jobs…</p>}

      {phase === "unavailable" && (
        <div role="alert">
          <p className="trace-card__text">{problem}</p>
          <button className="btn btn--ink btn--sm trace-card__action" type="button" onClick={onRetry}>Retry</button>
        </div>
      )}

      {phase === "idle" && (
        <>
          <p className="trace-card__text">Turns the narrow strokes of your logo into satin columns you can edit.</p>
          {workers === 0 && <p className="trace-card__note">No background worker is running, so a trace would wait in the queue until one starts.</p>}
          {estimate}
          <button className="btn btn--ink btn--sm trace-card__action" type="button" onClick={onStart}>Trace</button>
        </>
      )}

      {phase === "queued" && (
        <>
          <p className="trace-card__text" role="status">Queued: waiting for a free worker.</p>
          {estimate}
          <div className="trace-card__actions">{cancelButton}</div>
        </>
      )}

      {phase === "running" && job && (
        <>
          <div className="trace-card__running" role="status">
            <span className="ed-spinner" aria-hidden="true" />
            <span>Getting your layer ready</span>
          </div>
          <div className="trace-progress" role="progressbar" aria-label="Tracing progress" aria-valuemin={0} aria-valuemax={100}
               aria-valuenow={job.progress === null ? undefined : Math.round(job.progress * 100)}>
            <span className={job.progress === null ? "trace-progress__bar is-unknown" : "trace-progress__bar"}
                  style={job.progress === null ? undefined : { width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          {job.started_at && <Elapsed startedAt={job.started_at} offsetMs={clockOffsetMs} />}
          {estimate}
          <div className="trace-card__actions">{cancelButton}</div>
        </>
      )}

      {phase === "failed" && (
        <div role="alert">
          <p className="trace-card__text"><strong>Tracing failed.</strong> {job?.error}</p>
          <button className="btn btn--ink btn--sm trace-card__action" type="button" onClick={onStart}>Retry</button>
        </div>
      )}

      {phase === "cancelled" && (
        <>
          <p className="trace-card__text">Tracing was cancelled. Nothing on the canvas was changed.</p>
          <button className="btn btn--ink btn--sm trace-card__action" type="button" onClick={onStart}>Trace</button>
        </>
      )}

      {problem && phase !== "unavailable" && <p className="trace-card__problem" role="alert">{problem}</p>}
    </section>
  );
}
