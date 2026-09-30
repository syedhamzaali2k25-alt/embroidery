import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";

import { api, ApiError, type ClientConfig, type DesignCreated } from "../lib/api";
import { imageColours, type ImageColour } from "../lib/colours";
import { FlowBar } from "../lib/FlowBar";
import { Icon } from "../lib/Icon";
import { usePage } from "../lib/usePage";
import "../css/flow.css";

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };
type UploadState =
  | { status: "empty" }
  | { status: "uploading"; file: File; url: string }
  | { status: "done"; file: File; url: string; design: DesignCreated }
  | { status: "error"; file: File; url: string; message: string };

const ACCEPT = ".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml";

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

export default function Upload() {
  usePage("Upload a logo · Stitchbook", "flow");
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<Load<ClientConfig>>({ status: "loading" });
  const [upload, setUpload] = useState<UploadState>({ status: "empty" });
  const [over, setOver] = useState(false);
  const [width, setWidth] = useState("");
  const [colours, setColours] = useState<ImageColour[]>([]);

  const loadConfig = useCallback(() => {
    setConfig({ status: "loading" });
    api.config().then(
      (data) => {
        setConfig({ status: "ready", data });
        setWidth((w) => w || String(data.design_width_mm));
      },
      (err) => setConfig({ status: "error", message: message(err) }),
    );
  }, []);
  useEffect(loadConfig, [loadConfig]);

  const send = useCallback((file: File, url: string) => {
    setUpload({ status: "uploading", file, url });
    api.upload(file).then(
      (design) => setUpload({ status: "done", file, url, design }),
      (err) => setUpload({ status: "error", file, url, message: message(err) }),
    );
  }, []);

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (upload.status !== "empty") URL.revokeObjectURL(upload.url);
    const url = URL.createObjectURL(file);
    setColours([]);
    imageColours(url).then(setColours, () => setColours([]));
    send(file, url);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files[0]);
  };

  if (config.status !== "ready") {
    return (
      <>
        <FlowBar step={1} />
        <main className="flow-main">
          {config.status === "loading" ? (
            <div className="flow-state" role="status"><div className="flow-spinner" aria-hidden="true" /><p className="flow-state__title">Loading…</p></div>
          ) : (
            <div className="flow-state" role="alert">
              <p className="flow-state__title">The upload page can't start</p>
              <p className="flow-state__text">{config.message}</p>
              <div className="flow-state__actions"><button className="btn btn--ink" type="button" onClick={loadConfig}>Try again</button></div>
            </div>
          )}
        </main>
      </>
    );
  }

  const cfg = config.data;
  const widthMm = Number(width);
  const widthOk = width.trim() !== "" && widthMm > 0 && widthMm <= cfg.max_design_width_mm;
  const design = upload.status === "done" ? upload.design : null;
  const height = design?.logo_width_px && design.logo_height_px && widthOk
    ? (widthMm * design.logo_height_px) / design.logo_width_px
    : null;
  const isSvg = design?.type === "svg";
  const canContinue = Boolean(design) && widthOk && !isSvg;

  return (
    <>
      <FlowBar step={1} />
      <main className="flow-main">
        <h1 className="flow-title">Upload your <span className="accent">logo</span></h1>
        <p className="flow-lede">One logo per design. A dark logo on a plain light background, or a transparent PNG, works best.</p>

        <div className="flow-upload">
          <section
            className={`flow-drop${over ? " is-over" : ""}`}
            aria-label="Drop area"
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <input ref={input} className="visually-hidden" type="file" accept={ACCEPT} tabIndex={-1}
                   aria-hidden="true" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
            {upload.status === "empty" && (
              <>
                <Icon name="i-image" className="flow-drop__icon" />
                <p className="flow-drop__title">Drop your logo here</p>
                <p className="flow-drop__hint">
                  PNG, JPG or SVG, up to {(cfg.max_upload_bytes / 1_000_000).toFixed(0)} MB and {cfg.max_image_side_px} px on the long side
                </p>
                <button className="btn btn--ink" type="button" onClick={() => input.current?.click()}>Choose a file</button>
              </>
            )}
            {upload.status === "uploading" && (
              <div className="flow-state" role="status">
                <div className="flow-spinner" aria-hidden="true" />
                <p className="flow-state__title">Checking your image…</p>
                <p className="flow-drop__file">{upload.file.name}</p>
              </div>
            )}
            {upload.status === "error" && (
              <div className="flow-state" role="alert">
                <p className="flow-state__title">This file can't be used</p>
                <p className="flow-state__text">{upload.message}</p>
                <div className="flow-state__actions">
                  <button className="btn btn--ink" type="button" onClick={() => send(upload.file, upload.url)}>Try again</button>
                  <button className="btn btn--ghost" type="button" onClick={() => input.current?.click()}>Choose another file</button>
                </div>
              </div>
            )}
            {upload.status === "done" && (
              <>
                <img className="flow-drop__image" src={upload.url} alt={`Your logo: ${upload.file.name}`} />
                <p className="flow-drop__file">
                  {upload.file.name}
                  {upload.design.width_px && upload.design.height_px ? ` · ${upload.design.width_px} × ${upload.design.height_px} px` : ""}
                </p>
                <div className="flow-drop__actions">
                  <button className="btn btn--ghost btn--sm" type="button" onClick={() => input.current?.click()}>Choose another file</button>
                </div>
              </>
            )}
          </section>

          <div>
            <section className="flow-card" aria-labelledby="checks-title">
              <h2 className="flow-card__title" id="checks-title">Image check</h2>
              {!design && <p className="flow-note">Choose a file and we'll check its size, contrast and sharpness.</p>}
              {design && isSvg && (
                <p className="flow-note">
                  SVG files are accepted, but they can't be turned into stitches yet. Export the logo as PNG and upload that to continue.
                </p>
              )}
              {design && !isSvg && (
                <ul className="flow-checks">
                  {design.warnings.length === 0 && (
                    <li><span className="mark mark--ok" aria-hidden="true">✓</span>No problems found: size, contrast and edges look good.</li>
                  )}
                  {design.warnings.map((w) => (
                    <li key={w.code}><span className="mark" aria-hidden="true">!</span>{w.message}</li>
                  ))}
                  {design.logo_width_px === null && (
                    <li><span className="mark" aria-hidden="true">!</span>No logo shapes were found. Use a dark logo on a plain light background.</li>
                  )}
                </ul>
              )}
            </section>

            <section className="flow-card" aria-labelledby="options-title">
              <h2 className="flow-card__title" id="options-title">Options</h2>
              <div className="flow-switch-row">
                <span className="flow-label" id="bg-label"><strong>Remove background</strong></span>
                <button className="flow-switch" type="button" role="switch" aria-checked="true" aria-labelledby="bg-label" disabled />
              </div>
              <p className="flow-note">Always on for now: the light or transparent background is left out and only the logo is stitched.</p>

              <div className="flow-field" style={{ marginTop: 18 }}>
                <span className="flow-label">Colours to keep</span>
                {colours.length === 0 ? (
                  <p className="flow-field__help">{design ? "Reading colours…" : "The colours in your image appear here."}</p>
                ) : (
                  <ul className="flow-swatches" aria-label="Colours found in your image">
                    {colours.map((c) => (
                      <li key={c.hex}>
                        <label className="flow-swatch">
                          <input type="checkbox" checked disabled readOnly />
                          <span className="flow-swatch__chip" style={{ "--swatch": c.hex } as CSSProperties} aria-hidden="true" />
                          {c.hex} · {Math.round(c.share * 100)}%
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="flow-field__help">
                  Stitchbook sews one thread colour for now, so these can't be chosen yet: the logo's shapes are stitched in a single colour.
                </p>
              </div>

              <div className="flow-field">
                <label htmlFor="width">Design width</label>
                <div className="flow-input">
                  <input id="width" type="number" inputMode="decimal" min={1} max={cfg.max_design_width_mm} step="0.5"
                         value={width} onChange={(e) => setWidth(e.target.value)} aria-describedby="width-help" />
                  <span className="unit">mm</span>
                </div>
                {!widthOk ? (
                  <p className="flow-field__error" id="width-help">Enter a width above 0 and at most {cfg.max_design_width_mm} mm.</p>
                ) : (
                  <p className="flow-field__help" id="width-help">
                    {height !== null
                      ? `Height: ${height.toFixed(1)} mm (follows the logo's proportions)`
                      : "Height follows automatically once your logo is checked."}
                  </p>
                )}
              </div>

              <button className="btn btn--ink btn--lg flow-continue" type="button" disabled={!canContinue}
                      onClick={() => design && navigate(`/preview/${design.id}?width=${widthMm}`)}>
                Continue to preview <Icon name="i-arrow" />
              </button>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
