import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, TIMED_OUT, type ClientConfig, type Job } from "./api";

export type TracePhase = "loading" | "unavailable" | "idle" | "queued" | "running" | "done" | "failed" | "cancelled";

export type TraceState = {
  phase: TracePhase;
  job: Job | null;
  /** A problem talking to the server (not the job's own failure), in plain words. */
  problem: string | null;
  /** Milliseconds between the server clock and ours, from the last response. */
  clockOffsetMs: number;
  /** Workers listening for jobs, from the last health check; null when unknown. */
  workers: number | null;
};

type Polling = Pick<ClientConfig, "poll_start_s" | "poll_max_s" | "poll_backoff_factor" | "status_timeout_s">;

/** Next wait between status checks: grows by the backoff factor, never above the maximum. */
export function nextDelayMs(currentMs: number, cfg: Pick<Polling, "poll_max_s" | "poll_backoff_factor">): number {
  return Math.min(currentMs * cfg.poll_backoff_factor, cfg.poll_max_s * 1000);
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

/** 503 (the job queue is down), no answer in time, or no server at all: tracing can't work now. */
function jobsUnavailable(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 503) return err.message;
  if (err.status === TIMED_OUT) return `${err.message} Background jobs may not be running, so satin columns cannot be traced right now.`;
  if (err.status === 0) return err.message;
  return null;
}

const initial: TraceState = { phase: "loading", job: null, problem: null, clockOffsetMs: 0, workers: null };

/**
 * State of a design's "Create satin columns" job. The job runs on the server, so leaving the
 * page does not stop it; opening the design again picks up its last job (design.trace_job_id).
 * Opening first asks whether background jobs can run at all (with a timeout), so the card never
 * waits forever. Polling starts at poll_start_s, grows to poll_max_s, and pauses while the tab
 * is hidden.
 */
export function useTraceJob(designId: string | null, lastJobId: string | null | undefined, cfg: Polling | null) {
  const [state, setState] = useState<TraceState>(initial);
  const timer = useRef<number | null>(null);
  const delay = useRef(0);
  const jobId = useRef<string | null>(null);
  const alive = useRef(true);
  const timeoutS = cfg?.status_timeout_s;

  const stopPolling = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const apply = useCallback((job: Job) => {
    jobId.current = job.id;
    setState((s) => ({ ...s, phase: job.status, job, problem: null, clockOffsetMs: Date.parse(job.server_time) - Date.now() }));
  }, []);

  const unavailable = useCallback((problem: string) => {
    stopPolling();
    setState((s) => ({ ...s, phase: "unavailable", problem }));
  }, []);

  const poll = useCallback(async () => {
    stopPolling();
    if (!alive.current || !cfg || !jobId.current || document.hidden) return;
    try {
      const job = await api.job(jobId.current, timeoutS);
      if (!alive.current) return;
      apply(job);
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return;
    } catch (err) {
      if (!alive.current) return;
      const down = jobsUnavailable(err);
      if (down) return unavailable(down);
      setState((s) => ({ ...s, problem: `${message(err)} Checking again shortly.` }));
    }
    if (document.hidden) return; // resumes on visibilitychange
    delay.current = nextDelayMs(delay.current, cfg);
    timer.current = window.setTimeout(poll, delay.current);
  }, [apply, unavailable, cfg, timeoutS]);

  const schedule = useCallback(() => {
    if (!cfg) return;
    stopPolling();
    delay.current = cfg.poll_start_s * 1000;
    if (!document.hidden) timer.current = window.setTimeout(poll, delay.current);
  }, [cfg, poll]);

  /** Check that background jobs can run, then pick up the design's last job (or show "idle"). */
  const restore = useCallback(async () => {
    if (!designId || !cfg) return;
    stopPolling();
    setState((s) => ({ ...s, phase: "loading", problem: null }));
    try {
      const health = await api.jobsHealth(timeoutS);
      if (!alive.current) return;
      setState((s) => ({ ...s, workers: health.workers }));
    } catch (err) {
      if (alive.current) unavailable(jobsUnavailable(err) ?? message(err));
      return;
    }
    if (!jobId.current) {
      setState((s) => ({ ...s, phase: "idle", job: null }));
      return;
    }
    try {
      const job = await api.job(jobId.current, timeoutS);
      if (!alive.current) return;
      apply(job);
      if (job.status === "queued" || job.status === "running") schedule();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 404) {
        jobId.current = null; // the job has expired: start afresh
        setState((s) => ({ ...s, phase: "idle", job: null }));
      } else {
        unavailable(jobsUnavailable(err) ?? message(err));
      }
    }
  }, [designId, cfg, timeoutS, apply, schedule, unavailable]);

  useEffect(() => {
    alive.current = true;
    if (!designId || !cfg || lastJobId === undefined) return; // design and config still loading
    jobId.current = lastJobId;
    void restore();
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, [designId, lastJobId, cfg, restore]);

  // Stop polling while the tab is hidden; check at once when it is shown again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else if (jobId.current && (state.phase === "queued" || state.phase === "running") && cfg) {
        delay.current = cfg.poll_start_s * 1000;
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [state.phase, cfg, poll]);

  const start = useCallback(async () => {
    if (!designId) return;
    setState((s) => ({ ...s, problem: null }));
    try {
      const job = await api.trace(designId);
      apply(job);
      if (job.status === "queued" || job.status === "running") schedule();
    } catch (err) {
      const down = err instanceof ApiError && err.status === 503 ? err.message : null;
      if (down) unavailable(down);
      else setState((s) => ({ ...s, problem: message(err) }));
    }
  }, [designId, apply, schedule, unavailable]);

  const cancel = useCallback(async () => {
    if (!jobId.current) return;
    try {
      const job = await api.cancelJob(jobId.current);
      apply(job);
      if (job.status === "queued" || job.status === "running") schedule(); // stopping takes a moment
    } catch (err) {
      const down = err instanceof ApiError && err.status === 503 ? err.message : null;
      if (down) unavailable(down);
      else setState((s) => ({ ...s, problem: message(err) }));
    }
  }, [apply, schedule, unavailable]);

  return { ...state, start, cancel, retry: restore };
}
