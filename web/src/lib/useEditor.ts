import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type Edit, type EditorState } from "./api";

export type SaveStatus = "loading" | "saved" | "saving" | "failed";

export type EditorHook = {
  data: EditorState | null;
  /** The design could not be loaded at all (shown in place of the canvas). */
  loadProblem: string | null;
  status: SaveStatus;
  /** What is being saved right now, in words ("Split a satin shape"). */
  saving: string | null;
  /** The last change that failed, in plain words, with a way to send it again. */
  error: { what: string; message: string } | null;
  reload: () => void;
  edit: (edit: Edit, what: string) => Promise<boolean>;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  dismiss: () => void;
};

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

/**
 * The editor's design as the server has it. Every change goes to the API, and the canvas only
 * changes when the server answers with the new state: nothing is shown as done before it is
 * saved. A failed change keeps its request, so Retry sends exactly the same thing again.
 */
export function useEditor(designId: string | null): EditorHook {
  const [data, setData] = useState<EditorState | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<{ what: string; message: string } | null>(null);
  const last = useRef<{ what: string; run: () => Promise<EditorState> } | null>(null);
  const busy = useRef(false);

  const reload = useCallback(() => {
    if (!designId) return;
    setLoadProblem(null);
    setStatus("loading");
    api.editor(designId).then(
      (state) => { setData(state); setStatus("saved"); },
      (err) => { setLoadProblem(message(err)); setStatus("failed"); },
    );
  }, [designId]);
  useEffect(reload, [reload]);

  const run = useCallback(async (what: string, request: () => Promise<EditorState>) => {
    if (busy.current) return false; // one change at a time, in order
    busy.current = true;
    last.current = { what, run: request };
    setSaving(what);
    setStatus("saving");
    setError(null);
    try {
      const state = await request();
      setData(state);
      setStatus("saved");
      return true;
    } catch (err) {
      setError({ what, message: message(err) });
      setStatus("failed");
      return false;
    } finally {
      busy.current = false;
      setSaving(null);
    }
  }, []);

  const edit = useCallback((e: Edit, what: string) =>
    designId ? run(what, () => api.edit(designId, e)) : Promise.resolve(false), [designId, run]);
  const undo = useCallback(() =>
    designId && data?.history.undo ? run(`Undo: ${data.history.undo}`, () => api.undo(designId)) : Promise.resolve(false),
  [designId, data, run]);
  const redo = useCallback(() =>
    designId && data?.history.redo ? run(`Redo: ${data.history.redo}`, () => api.redo(designId)) : Promise.resolve(false),
  [designId, data, run]);
  const retry = useCallback(() => (last.current ? run(last.current.what, last.current.run) : Promise.resolve(false)), [run]);
  const dismiss = useCallback(() => { setError(null); setStatus(data ? "saved" : "failed"); }, [data]);

  return { data, loadProblem, status, saving, error, reload, edit, undo, redo, retry, dismiss };
}
