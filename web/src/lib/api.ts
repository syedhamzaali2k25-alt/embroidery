// Typed client for the Stitchbook API (api/src/stitchbook_api). Types mirror its pydantic models.
// When this build has sign-in, every request carries the signed-in user's access token; a 401
// means "log in first" (see needsLogin).
import { accessToken, loginPath, signInEnabled } from "./auth";

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8000";

export type QualityWarning = {
  code: "too_small" | "low_contrast" | "blurry_edges" | "many_specks";
  message: string;
  value: number;
  threshold: number;
};

export type SiteInfo = {
  app_name: string; demo_video_url: string; export_formats: string[];
  /** Owner decisions from config.py; null = not chosen yet (pages show "Not chosen yet"). */
  company_name: string | null; contact_email: string | null; governing_country: string | null;
  data_retention_days: number | null; last_updated: string | null; max_upload_bytes: number | null;
};

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
/** How a shape is sewn. "column": a satin column made in the editor between two edges. */
export type ShapeKind = "fill" | "satin" | "running" | "column";
export type DesignShape = {
  number: number; colour: number; kind: ShapeKind; max_width_mm: number; area_mm2: number; bounds_mm: number[];
  /** The stitch type was chosen in the editor (not from the shape's width). */
  kind_chosen?: boolean;
  /** Set in the editor; null = the default from config. */
  pull_compensation_mm?: number | null;
  /** Density set in the editor (fill row spacing / satin spacing, mm); null = the default. */
  fill_spacing_mm?: number | null;
  satin_spacing_mm?: number | null;
  /** For a sublayer: the number of the shape it is part of. */
  parent?: number | null;
  /** Numbers of this shape's sublayers. */
  sublayers?: number[];
  /** Plain notes about how the shape will be sewn. */
  notes?: string[];
  /** For kind "column": the two edges it runs between (mm). */
  edges?: { left: number[][]; right: number[][]; closed: boolean } | null;
  /** Outline first, then holes; points in mm (includes the overlap). */
  rings: number[][][];
  /** Where this shape runs under a later colour it touches: polygons (outline, then holes), mm. */
  overlap?: number[][][][];
};
export type DesignShapes = {
  id: string; colours: ColourLayer[]; shapes: DesignShape[]; bounds_mm: number[]; width_mm: number; height_mm: number;
  shapes_found: number; specks_removed: number;
  /** Editor changes that no longer fit the design (e.g. their colour was left out), in words. */
  skipped_edits?: string[];
  /** Fabric preset in effect; null = the stitch defaults. */
  fabric?: string | null;
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
  /** Only "private" exists: only its owner can open it. */
  visibility?: "private";
};
/** One row of "My designs" (GET /designs). */
export type DesignSummary = {
  id: string; filename: string; type: "png" | "jpg" | "svg"; status: "uploaded" | "digitized"; created_at: string;
  colour_count: number; stitch_count: number | null; width_mm: number | null; height_mm: number | null;
};
/** GET /designs/{id}/download-url: a short-lived signed link, or (local mode) the API's own path. */
export type DownloadLink = { url: string; filename: string; expires_in_s: number | null; signed: boolean };
/** GET /formats: what can be exported (write-then-read round trip passes), and why not for the rest. */
export type Formats = {
  formats: string[];
  labels: Record<string, string>;
  unavailable: { format: string; label: string; reason: string }[];
};

export type StitchPoint = { x_mm: number; y_mm: number; command: "stitch" | "jump" | "trim" | "end"; layer: number | null };
export type Layer = {
  number: number; type: "fill" | "satin" | "running" | "junction patch"; stitch_count: number; colour: number;
  /** The shape this layer sews (as numbered in shapes). */
  shape?: number | null;
};

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

/** Every failure carries a message a person can act on (and the server's body, e.g. a 402's numbers). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> | null = null) {
    super(message);
  }
}

/** A plan from config.py (GET /plans). null = not chosen yet: shown as a visible placeholder. */
export type PlanInfo = {
  id: "free" | "pro" | "business";
  name: string | null;
  price_monthly: string | null;
  price_yearly: string | null;
  price_yearly_per_month: string | null;
  credits: number | null;
  /** "lifetime" (given once) or "month" (every UTC calendar month). */
  credit_period: string | null;
  /** From config.py; "coming_soon" shows a tag and unlocks nothing yet. null = not chosen. */
  features: { key: string; name: string; status: "available" | "coming_soon" }[] | null;
};
export type Plans = {
  currency: string | null;
  yearly_discount_percent: number | null;
  plans: PlanInfo[];
  credit_costs: Record<string, number | null>;
  monthly_rollover: boolean | null;
  credit_packs: { credits: number; price: number }[] | null;
  refund_policy: string | null;
  /** /billing, back from the payment page: check every poll_s seconds for at most wait_s (null = not chosen). */
  checkout_return: { poll_s: number | null; wait_s: number | null };
  payments_available: boolean;
};
export type Balance = { available: number; reserved: number; consumed: number };
export type Account =
  | { enabled: false }
  | {
      enabled: true; plan: PlanInfo["id"]; plan_name: string | null; interval: "month" | "year" | null; status: string;
      balances: Record<"plan" | "purchased", Balance>; available: number; costs: Record<string, number>;
      history: { job_id: string; design_id: string | null; operation: string; format: string | null; status: string;
        credits: number; created_at: string; finished_at: string | null; error: string | null }[];
    };

/** A page of rows, newest first. */
export type Paged<T> = { items: T[]; page: number; page_size: number; has_more: boolean };
export type ExportRow = { job_id: string; design_id: string | null; design_name: string | null; format: string | null;
  bytes: number | null; credits: number; finished_at: string };
export type Exports = { enabled: false } | ({ enabled: true } & Paged<ExportRow>);
export type UsageEntry = { kind: "grant" | "spend"; reason: string; amount: number; bucket: string | null; at: string;
  operation: string | null; design_id: string | null; acting_user: { id: string; email: string | null } | null };
export type Usage = { enabled: false } | {
  enabled: true; balances: Record<"plan" | "purchased", Balance>; available: number;
  renewal: { date: string; renews: boolean } | null; spent_this_month: number; entries: Paged<UsageEntry>;
};
/** 403 {error: "plan_required", plan}: the plan that includes the feature. */
export const planRequired = (err: unknown): string | null =>
  err instanceof ApiError && err.status === 403 && err.body?.error === "plan_required" ? String(err.body.plan ?? "") : null;

/** Status 0: the server could not be reached. TIMED_OUT: it did not answer within the time allowed. */
export const TIMED_OUT = -1;

/** True for "sign in first" (401). Pages send the visitor to log in and back. */
export const needsLogin = (err: unknown) => signInEnabled && err instanceof ApiError && err.status === 401;
/** The log-in address that returns to the page the visitor is on now. */
export const loginHere = () => loginPath(location.pathname + location.search);

/** stayOn401: a background request (the credit balance) must not send the visitor to log in
 *  when it races a log-out; the page itself decides. */
type Options = RequestInit & { timeoutS?: number; stayOn401?: boolean };

async function request<T>(path: string, { timeoutS, stayOn401, ...init }: Options = {}): Promise<T> {
  let response: Response;
  const signal = timeoutS ? AbortSignal.timeout(timeoutS * 1000) : undefined;
  try {
    const token = await accessToken();
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    response = await fetch(`${API_URL}${path}`, { ...init, headers, signal });
  } catch (err) {
    if (signal?.aborted && err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(`The server did not answer within ${timeoutS} ${timeoutS === 1 ? "second" : "seconds"}.`, TIMED_OUT);
    }
    throw new ApiError(`Can't reach the Stitchbook server at ${API_URL}. Check that it is running, then try again.`, 0);
  }
  if (!response.ok) {
    let message = `The server answered with an error (${response.status}). Try again in a moment.`;
    let body: Record<string, unknown> | null = null;
    try {
      body = await response.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // keep the generic message
    }
    const error = new ApiError(message, response.status, body);
    // Signed out (or the session ended): log in, then come back to this page.
    if (needsLogin(error) && !stayOn401 && !location.pathname.startsWith("/login")) location.assign(loginHere());
    throw error;
  }
  return response.json() as Promise<T>;
}

// ---------- editor ----------

export type OutlineRef = { shape: number; ring: number };
export type DrawnEdge = { points: number[][] };
/** One change, as the editor sends it: shape numbers as listed now, points in mm. */
export type Edit =
  | { op: "set_type"; shape: number; kind: "running" | "satin" | "fill" }
  | { op: "set_pull_compensation"; shape: number; mm: number | null }
  | { op: "split"; a: number[]; b: number[] }
  | { op: "column"; left: OutlineRef | DrawnEdge; right: OutlineRef | DrawnEdge; colour?: number }
  | { op: "fabric"; preset: string | null }
  | { op: "set_density"; shape: number; mm: number | null }
  | { op: "sublayer"; shape: number; points: number[][] };
/** A fabric preset from config.py. Its values are UNVERIFIED unless `verified` (sewn and checked by the owner). */
export type FabricPreset = {
  name: string;
  label: string;
  verified: boolean;
  /** All its values are chosen in config.py; false = it cannot be chosen yet. */
  ready: boolean;
  values: {
    fill_row_spacing_mm: number; satin_spacing_mm: number; underlay_spacing_mm: number;
    underlay_edge_walk: boolean; underlay_zigzag: boolean; pull_compensation_mm: number;
  } | null;
};
export type EditorState = {
  id: string;
  shapes: DesignShapes;
  /** Satin columns, numbered in sewing order. */
  columns: TraceColumn[];
  colours: ColourLayer[];
  layers: Layer[];
  stats: Preview["stats"];
  stitches: StitchPoint[];
  history: { applied: number; total: number; undo: string | null; redo: string | null };
  defaults: {
    pull_compensation_mm: number; pull_compensation_min_mm: number; pull_compensation_max_mm: number;
    fill_row_spacing_mm: number; fill_row_spacing_min_mm: number; fill_row_spacing_max_mm: number;
    satin_spacing_mm: number; satin_spacing_min_mm: number; satin_spacing_max_mm: number;
    satin_max_width_mm: number;
  };
  /** The fabric preset in effect (null = the stitch defaults) and every preset in config order. */
  fabric: { preset: string | null; presets: FabricPreset[] };
};

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/**
 * At most one request of a kind per design at a time. The same request while one is running
 * (React StrictMode runs effects twice in development) shares the running one; a different one
 * (say, new settings) waits for it and then goes. The server also sews one design at a time,
 * but this saves it digitizing twice.
 */
const running = new Map<string, { same: string; promise: Promise<unknown> }>();
function oneAtATime<T>(slot: string, same: string, send: () => Promise<T>): Promise<T> {
  const current = running.get(slot);
  if (current && current.same === same) return current.promise as Promise<T>;
  const promise: Promise<T> = (current ? current.promise.catch(() => undefined).then(send) : send()).finally(() => {
    if (running.get(slot)?.promise === promise) running.delete(slot);
  });
  running.set(slot, { same, promise });
  return promise;
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
  editor: (id: string) => oneAtATime(`editor:${id}`, "", () => request<EditorState>(`/designs/${id}/editor`)),
  edit: (id: string, edit: Edit) => request<EditorState>(`/designs/${id}/edits`, post(edit)),
  undo: (id: string) => request<EditorState>(`/designs/${id}/edits/undo`, post()),
  redo: (id: string) => request<EditorState>(`/designs/${id}/edits/redo`, post()),
  preview: (id: string, settings: DesignSettings = {}) =>
    oneAtATime(`preview:${id}`, JSON.stringify(settings), () => request<Preview>(`/designs/${id}/preview`, post(settings))),
  designs: () => request<DesignSummary[]>("/designs"),
  /** The API's own download path: what a build without sign-in links to directly. */
  downloadUrl: (id: string, format = "dst") => `${API_URL}/designs/${id}/download?format=${encodeURIComponent(format)}`,
  /** A link to the machine file: signed and short-lived with sign-in, the API path without. */
  downloadLink: async (id: string, format = "dst") => {
    const link = await request<DownloadLink>(`/designs/${id}/download-url?format=${encodeURIComponent(format)}`);
    return { ...link, url: link.signed ? link.url : `${API_URL}${link.url}` };
  },
  formats: () => request<Formats>("/formats"),
  plans: () => request<Plans>("/plans"),
  credits: () => request<Account>("/me/credits", { stayOn401: true }),
  checkout: (plan: "pro" | "business", interval: "month" | "year") => request<{ url: string }>("/billing/checkout", post({ plan, interval })),
  exports: (page = 1) => request<Exports>(`/exports?page=${page}`),
  usage: (page = 1) => request<Usage>(`/credits/usage?page=${page}`),
  /** The payment provider's own page to manage or cancel the plan (null when there is none). */
  manageBilling: () => request<{ url: string | null }>("/billing/manage"),
  cancelPlan: () => request<{ status: string }>("/billing/cancel", { method: "POST" }),
  trace: (designId: string) => request<Job>(`/designs/${designId}/trace`, { method: "POST" }),
  jobsHealth: (timeoutS?: number) => request<JobsHealth>("/jobs/health", { timeoutS }),
  job: (jobId: string, timeoutS?: number) => request<Job>(`/jobs/${jobId}`, { timeoutS }),
  cancelJob: (jobId: string) => request<Job>(`/jobs/${jobId}/cancel`, { method: "POST" }),
};
