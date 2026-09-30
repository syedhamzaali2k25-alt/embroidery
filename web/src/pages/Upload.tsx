import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";

import { api, ApiError, type ClientConfig, type DesignCreated } from "../lib/api";
import { FlowBar } from "../lib/FlowBar";
import { takePendingUpload } from "../lib/pendingUpload";
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
  // Detected colours the user keeps (all of them until they uncheck some).
  const [kept, setKept] = useState<Set<string>>(new Set());

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
      (design) => {
        setKept(new Set(design.colours.map((c) => c.hex)));
        setUpload({ status: "done", file, url, design });
      },
      (err) => setUpload({ status: "error", file, url, message: message(err) }),
    );
  }, []);

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (upload.status !== "empty") URL.revokeObjectURL(upload.url);
    const url = URL.createObjectURL(file);
    setKept(new Set());
    send(file, url);
  };

  // A file dropped on the Landing page arrives here and is uploaded as soon as the page is ready.
  const ready = config.status === "ready";
  useEffect(() => {
    if (!ready) return;
    const file = takePendingUpload();
    if (file) choose(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

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
  const colours = design?.colours ?? [];
  const keptColours = colours.filter((c) => kept.has(c.hex));
  // The design's proportions follow the colours that are kept (their shapes' bounding box).
  const box = keptColours.length
    ? keptColours.map((c) => c.bounds_px).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])
    : null;
  const height = box && box[2] > box[0] && widthOk ? (widthMm * (box[3] - box[1])) / (box[2] - box[0]) : null;
  const isSvg = design?.type === "svg";
  const coloursOk = isSvg || colours.length === 0 || keptColours.length > 0;
  const canContinue = Boolean(design) && widthOk && !isSvg && coloursOk && colours.length > 0;
  const toggle = (hex: string) =>
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(hex)) next.delete(hex);
      else next.add(hex);
      return next;
    });
  const continueTo = () => {
    if (!design) return;
    const subset = keptColours.length < colours.length ? `&colours=${encodeURIComponent(keptColours.map((c) => c.hex).join(","))}` : "";
    navigate(`/preview/${design.id}?width=${widthMm}${subset}`);
  };

  return (
    <>
      <FlowBar step={1} />
      <main className="flow-main">
        <h1 className="flow-title">Upload your <span className="accent">logo</span></h1>
        <p className="flow-lede">One logo per design. Flat colours on a plain background, or a transparent PNG, work best.</p>

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
                    <li><span className="mark" aria-hidden="true">!</span>No logo shapes were found. Use a logo on a plain background, or a transparent PNG.</li>
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
              <p className="flow-note">
                {design && !isSvg && colours.length > 0
                  ? design.background
                    ? <>Always on: the background colour <span className="flow-hex">{design.background}</span> touches the image's edges, so it is left out.</>
                    : "Always on: your image's transparent background is left out."
                  : "Always on: the colour around the edges of your image (or its transparency) is left out."}
              </p>

              <fieldset className="flow-field flow-colours" style={{ marginTop: 18 }} aria-describedby="colours-help">
                <legend className="flow-label">Colours to keep</legend>
                {colours.length === 0 ? (
                  <p className="flow-field__help">
                    {upload.status === "uploading" ? "Reading colours…" : design && !isSvg ? "No colours were found." : "The colours in your image appear here."}
                  </p>
                ) : (
                  <>
                    <p className="flow-colours__count" aria-live="polite">
                      <strong>{keptColours.length} of {colours.length}</strong> {colours.length === 1 ? "colour" : "colours"} kept
                    </p>
                    <ul className="flow-swatches" aria-label="Colours found in your image">
                      {colours.map((c) => (
                        <li key={c.hex}>
                          <label className="flow-swatch">
                            <input type="checkbox" checked={kept.has(c.hex)} onChange={() => toggle(c.hex)} />
                            <span className="flow-swatch__chip" style={{ "--swatch": c.hex } as CSSProperties} aria-hidden="true" />
                            <span>{c.hex} · {c.share < 0.01 ? "<1" : Math.round(c.share * 100)}%</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {!coloursOk ? (
                  <p className="flow-field__error" id="colours-help">Keep at least one colour.</p>
                ) : (
                  <p className="flow-field__help" id="colours-help">
                    Each colour you keep is sewn as its own layer, with a thread change in between. Unchecked colours are left out.
                  </p>
                )}
              </fieldset>

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
                      onClick={continueTo}>
                Continue to preview <Icon name="i-arrow" />
              </button>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
