// Typed client for the Stitchbook API (api/src/stitchbook_api). Types mirror its pydantic models.

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

export type QualityWarning = {
  code: "too_small" | "low_contrast" | "blurry_edges";
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
};

export type DesignCreated = {
  id: string;
  type: "png" | "jpg" | "svg";
  width_px: number | null;
  height_px: number | null;
  logo_width_px: number | null;
  logo_height_px: number | null;
  warnings: QualityWarning[];
};

export type DesignSettings = { width_mm?: number | null; fill_row_spacing_mm?: number | null };

export type DesignRecord = DesignCreated & {
  filename: string;
  bytes: number;
  settings: DesignSettings;
  status: "uploaded" | "digitized";
};

export type StitchPoint = { x_mm: number; y_mm: number; command: "stitch" | "jump" | "trim" | "end"; layer: number | null };
export type Layer = { number: number; type: "fill" | "satin" | "junction patch"; stitch_count: number };

export type Preview = {
  id: string;
  stats: {
    stitch_count: number; jump_count: number; trim_count: number; width_mm: number; height_mm: number;
    longest_stitch_mm: number; longest_jump_mm: number; color_count: number;
  };
  report: {
    jumps: number; trims: number; fill_areas: number; satin_columns: number; junction_patches: number;
    skipped_rungs: number; trimmed_rungs: number;
  };
  settings_used: { width_mm: number; fill_row_spacing_mm: number };
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, init);
  } catch {
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
  preview: (id: string, settings: DesignSettings = {}) =>
    request<Preview>(`/designs/${id}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }),
  downloadUrl: (id: string) => `${API_URL}/designs/${id}/download?format=dst`,
};
