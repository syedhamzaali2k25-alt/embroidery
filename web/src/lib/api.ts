// Typed client for the Stitchbook API (api/src/stitchbook_api). Types mirror its pydantic models.

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

export type QualityWarning = {
  code: "too_small" | "low_contrast" | "blurry_edges" | "many_specks";
  message: string;
  value: number;
  threshold: number;
};

export type SiteInfo = { app_name: string; demo_video_url: string; export_formats: string[] };

export type ClientConfig = {
  app_name: string;
  allowed_types: string[];
  max_upload_bytes: number;
  max_image_side_px: number;
  design_width_mm: number;
  max_design_width_mm: number;
  fill_row_spacing_mm: number;
  fill_row_spacing_min_mm: number;
  fill_row_spacing_max_mm: number;
  trace_estimate_minutes: number | null;
  poll_start_s: number;
  poll_max_s: number;
  poll_backoff_factor: number;
  status_timeout_s: number;
};

export type TraceColumn = {
  number: number; left: number[][]; right: number[][]; edit_points: number[][]; label: number[];
  shape?: number | null; colour?: number | null;
};
/** Thread names and codes are not chosen yet: the API always sends this labelled placeholder. */
export type ThreadPlaceholder = { name: string; code: string; placeholder: true };
/** A colour layer: the image's own colour, sewn as one thread, in sewing order. */
export type ColourLayer = {
  number: number; hex: string; shape_count: number; area_mm2: number; stitch_count?: number | null; thread: ThreadPlaceholder;
};
export type DetectedColour = { hex: string; share: number; shape_count: number; bounds_px: number[] };
export type DesignShape = {
  number: number; colour: number; kind: "fill" | "satin"; max_width_mm: number; area_mm2: number; bounds_mm: number[];
  /** Outline first, then holes; points in mm (includes the overlap). */
  rings: number[][][];
  /** Where this shape runs under a later colour it touches: polygons (outline, then holes), mm. */
  overlap?: number[][][][];
};
export type DesignShapes = {
  id: string; colours: ColourLayer[]; shapes: DesignShape[]; bounds_mm: number[]; width_mm: number; height_mm: number;
  shapes_found: number; specks_removed: number;
};
export type JobsHealth = { status: "ok"; workers: number };
export type TraceResult = { columns: TraceColumn[]; fill_shapes: number; junction_patches: number; bounds_mm: number[]; width_mm: number };
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Job = {
  id: string;
  design_id: string;
  kind: "trace";
  status: JobStatus;
  progress: number | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  server_time: string;
  cancel_requested: boolean;
  error: string | null;
  result: TraceResult | null;
};

export type DesignCreated = {
  id: string;
  type: "png" | "jpg" | "svg";
  width_px: number | null;
  height_px: number | null;
  logo_width_px: number | null;
  logo_height_px: number | null;
  /** Colours found in the image (background removed), largest area first. */
  colours: DetectedColour[];
  /** Removed background colour, or null when the background was transparent. */
  background: string | null;
  specks_removed: number;
  warnings: QualityWarning[];
};

export type DesignSettings = { width_mm?: number | null; fill_row_spacing_mm?: number | null; colours?: string[] | null };

export type DesignRecord = DesignCreated & {
  filename: string;
  bytes: number;
  settings: DesignSettings;
  status: "uploaded" | "digitized";
  trace_job_id: string | null;
};

export type StitchPoint = { x_mm: number; y_mm: number; command: "stitch" | "jump" | "trim" | "end"; layer: number | null };
export type Layer = { number: number; type: "fill" | "satin" | "junction patch"; stitch_count: number; colour: number };

export type Preview = {
  id: string;
  stats: {
    stitch_count: number; jump_count: number; trim_count: number; width_mm: number; height_mm: number;
    longest_stitch_mm: number; longest_jump_mm: number; color_count: number;
  };
  report: {
    jumps: number; trims: number; fill_areas: number; satin_columns: number; junction_patches: number;
    skipped_rungs: number; trimmed_rungs: number; colour_changes: number; shapes_found: number; specks_removed: number;
    holes_filled: number;
  };
  settings_used: { width_mm: number; fill_row_spacing_mm: number };
  colours: ColourLayer[];
  /** Where one colour runs under a later colour it touches: polygons (outline, then holes), mm. */
  overlaps: number[][][][];
  layers: Layer[];
  warnings: QualityWarning[];
  stitches: StitchPoint[];
};

/** Every failure carries a message a person can act on. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Status 0: the server could not be reached. TIMED_OUT: it did not answer within the time allowed. */
export const TIMED_OUT = -1;

type Options = RequestInit & { timeoutS?: number };

async function request<T>(path: string, { timeoutS, ...init }: Options = {}): Promise<T> {
  let response: Response;
  const signal = timeoutS ? AbortSignal.timeout(timeoutS * 1000) : undefined;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, signal });
  } catch (err) {
    if (signal?.aborted && err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(`The server did not answer within ${timeoutS} ${timeoutS === 1 ? "second" : "seconds"}.`, TIMED_OUT);
    }
    throw new ApiError(`Can't reach the Stitchbook server at ${API_URL}. Check that it is running, then try again.`, 0);
  }
  if (!response.ok) {
    let message = `The server answered with an error (${response.status}). Try again in a moment.`;
    try {
      const body = await response.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // keep the generic message
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  site: () => request<SiteInfo>("/site"),
  config: () => request<ClientConfig>("/config"),
  upload: (file: File, settings: DesignSettings = {}) => {
    const form = new FormData();
    form.append("file", file);
    form.append("settings", JSON.stringify(settings));
    return request<DesignCreated>("/designs", { method: "POST", body: form });
  },
  design: (id: string) => request<DesignRecord>(`/designs/${id}`),
  shapes: (id: string) => request<DesignShapes>(`/designs/${id}/shapes`),
  preview: (id: string, settings: DesignSettings = {}) =>
    request<Preview>(`/designs/${id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }),
  downloadUrl: (id: string) => `${API_URL}/designs/${id}/download?format=dst`,
  trace: (designId: string) => request<Job>(`/designs/${designId}/trace`, { method: "POST" }),
  jobsHealth: (timeoutS?: number) => request<JobsHealth>("/jobs/health", { timeoutS }),
  job: (jobId: string, timeoutS?: number) => request<Job>(`/jobs/${jobId}`, { timeoutS }),
  cancelJob: (jobId: string) => request<Job>(`/jobs/${jobId}/cancel`, { method: "POST" }),
};
