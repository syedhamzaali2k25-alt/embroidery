import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type ClientConfig, type Job } from "./api";

export type TracePhase = "loading" | "idle" | "queued" | "running" | "done" | "failed" | "cancelled";

export type TraceState = {
  phase: TracePhase;
  job: Job | null;
  /** A problem talking to the server (not the job's own failure), in plain words. */
  problem: string | null;
  /** Milliseconds between the server clock and ours, from the last response. */
  clockOffsetMs: number;
};

type Polling = Pick<ClientConfig, "poll_start_s" | "poll_max_s" | "poll_backoff_factor">;

/** Next wait between status checks: grows by the backoff factor, never above the maximum. */
export function nextDelayMs(currentMs: number, cfg: Polling): number {
  return Math.min(currentMs * cfg.poll_backoff_factor, cfg.poll_max_s * 1000);
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

/**
 * State of a design's "Create satin columns" job. The job runs on the server, so leaving the
 * page does not stop it; opening the design again picks up its last job (design.trace_job_id).
 * Polling starts at poll_start_s, grows to poll_max_s, and pauses while the tab is hidden.
 */
export function useTraceJob(designId: string | null, lastJobId: string | null | undefined, cfg: Polling | null) {
  const [state, setState] = useState<TraceState>({ phase: "loading", job: null, problem: null, clockOffsetMs: 0 });
  const timer = useRef<number | null>(null);
  const delay = useRef(0);
  const jobId = useRef<string | null>(null);
  const alive = useRef(true);

  const stopPolling = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const apply = useCallback((job: Job) => {
    jobId.current = job.id;
    setState({ phase: job.status, job, problem: null, clockOffsetMs: Date.parse(job.server_time) - Date.now() });
  }, []);

  const poll = useCallback(async () => {
    stopPolling();
    if (!alive.current || !cfg || !jobId.current || document.hidden) return;
    try {
      const job = await api.job(jobId.current);
      if (!alive.current) return;
      apply(job);
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return;
    } catch (err) {
      if (!alive.current) return;
      setState((s) => ({ ...s, problem: `${message(err)} Checking again shortly.` }));
    }
    if (document.hidden) return; // resumes on visibilitychange
    delay.current = nextDelayMs(delay.current, cfg);
    timer.current = window.setTimeout(poll, delay.current);
  }, [apply, cfg]);

  const schedule = useCallback(() => {
    if (!cfg) return;
    stopPolling();
    delay.current = cfg.poll_start_s * 1000;
    if (!document.hidden) timer.current = window.setTimeout(poll, delay.current);
  }, [cfg, poll]);

  // Restore the design's last job when the editor opens (or show "idle").
  useEffect(() => {
    alive.current = true;
    if (!designId || !cfg || lastJobId === undefined) return;
    if (!lastJobId) {
      setState({ phase: "idle", job: null, problem: null, clockOffsetMs: 0 });
      return;
    }
    jobId.current = lastJobId;
    api.job(lastJobId).then(
      (job) => {
        if (!alive.current) return;
        apply(job);
        if (job.status === "queued" || job.status === "running") schedule();
      },
      () => alive.current && setState({ phase: "idle", job: null, problem: null, clockOffsetMs: 0 }),
    );
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, [designId, lastJobId, cfg, apply, schedule]);

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
      setState((s) => ({ ...s, problem: message(err) }));
    }
  }, [designId, apply, schedule]);

  const cancel = useCallback(async () => {
    if (!jobId.current) return;
    try {
      const job = await api.cancelJob(jobId.current);
      apply(job);
      if (job.status === "queued" || job.status === "running") schedule(); // stopping takes a moment
    } catch (err) {
      setState((s) => ({ ...s, problem: message(err) }));
    }
  }, [apply, schedule]);

  return { ...state, start, cancel };
}
