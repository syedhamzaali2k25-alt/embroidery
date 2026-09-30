import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, ApiError, type ClientConfig, type DesignSettings, type Preview as PreviewData } from "../lib/api";
import { FlowBar } from "../lib/FlowBar";
import { Icon } from "../lib/Icon";
import { StitchCanvas } from "../lib/StitchCanvas";
import { usePage } from "../lib/usePage";
import "../css/flow.css";

const LAYER_NAMES = { fill: "Fill", satin: "Satin", "junction patch": "Junction patch" } as const;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

function mm(value: number): string {
  return value.toFixed(1);
}

export default function Preview() {
  usePage("Preview · Stitchbook", "flow");
  const { designId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const [data, setData] = useState<PreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<DesignSettings>({});
  const [filename, setFilename] = useState<string>("");
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [width, setWidth] = useState("");
  const [spacing, setSpacing] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const run = useCallback((settings: DesignSettings) => {
    if (!designId) return;
    setBusy(true);
    setError(null);
    setLastRequest(settings);
    api.preview(designId, settings).then(
      (result) => {
        setData(result);
        setWidth(String(result.settings_used.width_mm));
        setSpacing(String(result.settings_used.fill_row_spacing_mm));
        setSelected(null);
        setBusy(false);
      },
      (err) => {
        setError(message(err));
        setBusy(false);
      },
    );
  }, [designId]);

  useEffect(() => {
    if (!designId) return;
    const w = Number(search.get("width"));
    run(w > 0 ? { width_mm: w } : {});
    api.design(designId).then((d) => setFilename(d.filename), () => setFilename(""));
    api.config().then(setConfig, () => setConfig(null));
  }, [designId, search, run]);

  // ---------- empty, first load, first error ----------
  if (!designId) {
    return (
      <Shell>
        <div className="flow-state">
          <Icon name="i-image" className="flow-drop__icon" />
          <p className="flow-state__title">No design to preview yet</p>
          <p className="flow-state__text">Upload a logo first; its stitches will show up here.</p>
          <div className="flow-state__actions"><Link className="btn btn--ink" to="/upload">Upload a logo</Link></div>
        </div>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        {error ? (
          <div className="flow-state" role="alert">
            <p className="flow-state__title">The preview couldn't be made</p>
            <p className="flow-state__text">{error}</p>
            <div className="flow-state__actions">
              <button className="btn btn--ink" type="button" onClick={() => run(lastRequest)}>Try again</button>
              <Link className="btn btn--ghost" to="/upload">Back to upload</Link>
            </div>
          </div>
        ) : (
          <div className="flow-state" role="status">
            <div className="flow-spinner" aria-hidden="true" />
            <p className="flow-state__title">Turning your logo into stitches…</p>
            <p className="flow-state__text">This takes a few seconds.</p>
          </div>
        )}
      </Shell>
    );
  }

  // ---------- loaded ----------
  const { stats, report, layers } = data;
  const w = Number(width), s = Number(spacing);
  const widthOk = w > 0 && (!config || w <= config.max_design_width_mm);
  const spacingOk = s > 0 && (!config || (s >= config.fill_row_spacing_min_mm && s <= config.fill_row_spacing_max_mm));
  const changed = w !== data.settings_used.width_mm || s !== data.settings_used.fill_row_spacing_mm;

  return (
    <Shell>
      <h1 className="flow-title">Preview your <span className="accent">stitches</span></h1>
      <p className="flow-lede">{filename ? `${filename} · ` : ""}Every line below is a stitch from the file you will download.</p>

      <div className="flow-preview">
        <aside className="flow-card" aria-labelledby="settings-title">
          <h2 className="flow-card__title" id="settings-title">Settings</h2>
          <form onSubmit={(e) => { e.preventDefault(); run({ width_mm: w, fill_row_spacing_mm: s }); }}>
            <div className="flow-field">
              <label htmlFor="pv-width">Design width</label>
              <div className="flow-input">
                <input id="pv-width" type="number" inputMode="decimal" step="0.5" min={1} max={config?.max_design_width_mm}
                       value={width} onChange={(e) => setWidth(e.target.value)} />
                <span className="unit">mm</span>
              </div>
              {!widthOk && <p className="flow-field__error">Enter a width above 0{config ? ` and at most ${config.max_design_width_mm} mm` : ""}.</p>}
            </div>
            <div className="flow-field">
              <label htmlFor="pv-spacing">Fill density</label>
              <div className="flow-input">
                <input id="pv-spacing" type="number" inputMode="decimal" step="0.05"
                       min={config?.fill_row_spacing_min_mm} max={config?.fill_row_spacing_max_mm}
                       value={spacing} onChange={(e) => setSpacing(e.target.value)} aria-describedby="pv-spacing-help" />
                <span className="unit">mm</span>
              </div>
              <p className={spacingOk ? "flow-field__help" : "flow-field__error"} id="pv-spacing-help">
                {spacingOk
                  ? "Space between fill rows. Smaller is denser."
                  : `Enter a spacing${config ? ` from ${config.fill_row_spacing_min_mm} to ${config.fill_row_spacing_max_mm} mm` : " above 0"}.`}
              </p>
            </div>
            <button className="btn btn--ink flow-continue" type="submit" disabled={busy || !changed || !widthOk || !spacingOk}>
              Update preview
            </button>
          </form>
        </aside>

        <section className="flow-preview__canvas" aria-label="Stitch preview">
          {error && (
            <div className="flow-card" role="alert" style={{ marginBottom: 12 }}>
              <p><strong>The preview couldn't be updated.</strong> {error}</p>
              <div className="flow-state__actions" style={{ justifyContent: "flex-start" }}>
                <button className="btn btn--ink btn--sm" type="button" onClick={() => run(lastRequest)}>Try again</button>
              </div>
            </div>
          )}
          <div className="flow-stage">
            <StitchCanvas stitches={data.stitches} selected={selected}
                          label={`Stitch preview: ${stats.stitch_count} stitches, ${mm(stats.width_mm)} by ${mm(stats.height_mm)} mm`} />
            {busy && (
              <div className="flow-stage__busy" role="status"><div className="flow-spinner" aria-hidden="true" />Updating stitches…</div>
            )}
            <div className="flow-stage__legend" aria-hidden="true">
              <span className="flow-legend"><span className="flow-legend__line" />Stitches</span>
              <span className="flow-legend"><span className="flow-legend__line flow-legend__line--jump" />Jumps</span>
              <span className="flow-legend"><span className="flow-legend__line flow-legend__line--active" />Selected layer</span>
            </div>
          </div>
        </section>

        <div>
          <section className="flow-card" aria-labelledby="summary-title">
            <h2 className="flow-card__title" id="summary-title">Summary</h2>
            <dl className="flow-summary">
              <div><dt>Stitches</dt><dd>{stats.stitch_count.toLocaleString("en")}</dd></div>
              <div><dt>Colours</dt><dd>{stats.color_count}</dd></div>
              <div className="wide"><dt>Size</dt><dd>{mm(stats.width_mm)} × {mm(stats.height_mm)} <small>mm</small></dd></div>
              <div className="wide"><dt>Jumps</dt><dd>{report.jumps} <small>· {report.trims} trims</small></dd></div>
            </dl>
            <div className="flow-actions">
              <a className="btn btn--ink" href={api.downloadUrl(data.id)}><Icon name="i-download" />Download DST</a>
              <button className="btn btn--ghost" type="button" onClick={() => navigate(`/editor?design=${data.id}`)}>
                Fix stitches in the editor
              </button>
            </div>
          </section>

          <section className="flow-card" aria-labelledby="layers-title">
            <h2 className="flow-card__title" id="layers-title">Layers</h2>
            <ul className="flow-layers">
              {layers.map((layer) => (
                <li key={layer.number}>
                  <button className="flow-layer" type="button" aria-pressed={selected === layer.number}
                          onClick={() => setSelected(selected === layer.number ? null : layer.number)}>
                    <span className="flow-layer__num">{layer.number}</span>
                    <span className="flow-layer__type">{LAYER_NAMES[layer.type]}</span>
                    <span className="flow-layer__count">{layer.stitch_count.toLocaleString("en")} stitches</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="flow-note">Layers are listed in sewing order. Select one to see it in green.</p>
          </section>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FlowBar step={2} />
      <main className="flow-main">{children}</main>
    </>
  );
}
