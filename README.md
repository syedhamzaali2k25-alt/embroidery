# Stitchbook

Browser-based embroidery digitizer: upload a PNG/JPG/SVG logo and get machine-ready embroidery files (DST first, then PES) plus a preview image. Stitchbook is a working name, set in `digitizer/src/digitizer/config.py`.

Status: the digitizer turns a PNG/JPG logo into a DST, a preview and a report. The image is reduced to a few flat colours (k-means in Lab), the background (the colour around the edges, or transparency) is removed, and specks below a minimum area are dropped. Each colour is its own layer, sewn largest area first with a colour change between layers; each shape is sewn completely, in order, from its own top-left entry, so a change to one shape (or colour) leaves every other shape's stitches exactly the same, and only the changed shapes are rebuilt (an in-memory piece cache, `engine.piece_cache_shapes`). Where two colours touch, the one sewn first runs `colour.overlap_mm` under the later one, so no fabric shows between them (never into colours it does not touch, never past the design's outer edge); Preview and Editor show the overlap as a darker seam. Wide shapes get fill; narrow shapes get satin columns with edge-walk/zigzag underlay and pull compensation; where satin strokes meet, a small fill patch covers the junction. No lock stitches or fill underlay yet, and thread names/codes are placeholders. The API accepts uploads (validation, quality and speck warnings, detected colours), digitizes small images on request with the colours the user keeps, and serves the DST. The web app's Upload, Preview and Editor screens use the API; Home is still a mock-up. In the Editor a shape's stitch type can be changed (Running, Satin, Fill), satin gets its own pull compensation, a satin shape can be split between two edge points, and a satin column can be made between two outlines ("Select Satin Columns") or two drawn edges ("Draw edges"). Every change is stored on the server (in image pixels, so it survives a change of width), re-sews the design so Preview and Download match, and can be undone and redone. Each shape has density and pull compensation sliders (ranges from config.py), and a shape can have sublayers: an outlined part of it with its own stitch type and settings. The Export card offers only formats from `GET /formats`: ones pyembroidery can write whose write-then-read round trip passes (today only DST; PES, JEF, VP3 and EXP fail and are shown disabled with the reason). The header shows the save state (Saving, Saved, Error with Retry), a read-only Private chip, and Close, which waits for a pending save or asks before leaving. Public pages: Privacy and Terms (drafts, not yet reviewed by a lawyer; they describe only what the code does today), Contact (a mailto link, no form) and a Blog read from Markdown files in `web/content/blog/` (none shipped; `_example.md` documents the format and is never shown). Owner decisions (`site.company_name`, `contact_email`, `governing_country`, `data_retention_days`, `last_updated`) are placeholders in config.py, returned by `GET /site`, and shown as "Not chosen yet" until chosen. A fabric preset (woven cotton, knit/jersey, cap/twill) can be chosen the same way; it replaces the density, underlay and pull compensation defaults (the density set on Preview and a shape's own pull compensation still win). Every preset value is a placeholder in config.py, marked UNVERIFIED, and the editor shows "Unverified: not yet tested on a machine" next to the picker.

## Layout

| Folder | What it is |
|---|---|
| `digitizer/` | Importable Python stitch library (`import digitizer`). No web code. |
| `api/` | FastAPI service (`stitchbook_api`), imports `digitizer`. |
| `worker/` | RQ job runner (`stitchbook_worker`), imports `digitizer`. |
| `web/` | Vite + React + TypeScript front end and its screenshot/contrast audit. |
| `digitizer/src/digitizer/config.py` | The single file for every stitch number, limit, timeout and rate limit. |
| `docs/` | Project documentation. |

## Requirements

Python 3.11+, Node 18+, Redis (for the worker), GNU Make.

## Commands

```sh
cp .env.example .env     # then fill in values
make setup               # .venv with digitizer/api/worker (editable) + web npm install
make test                # pytest + web colour-token lint
make api                 # FastAPI on http://localhost:$API_PORT (docs at /docs)
make worker              # RQ worker on $RQ_QUEUE, needs Redis at $REDIS_URL
make web                 # React front end (Vite dev server) on http://localhost:$WEB_PORT
```

Digitizer (inside the venv):

```sh
.venv/bin/python -m digitizer.digitize logo.png --out outdir   # needs every stitch value chosen in config.py
.venv/bin/python -m digitizer.digitize logo.png --out outdir --test-run-values   # stand-in values, not for sewing
.venv/bin/python -m digitizer.digitize logo.png --out outdir --width-mm 30        # design width for this job
.venv/bin/python -m digitizer.digitize logo.png --out outdir --colours "#1E3A6E,#F4A261"   # keep only these detected colours
.venv/bin/python -m digitizer.digitize logo.png --out outdir --edits edits.json   # editor changes (a design record's "edits")
.venv/bin/python -m digitizer.readback outdir/out.dst          # stitch count, size, longest stitch (+ report.json beside it)
.venv/bin/python digitizer/samples/make_samples.py             # regenerate the sample logos
.venv/bin/python digitizer/samples/run_samples.py              # digitize all samples, print DST readback
```

API (see http://localhost:$API_PORT/docs for the full schema):

| Endpoint | What it does |
|---|---|
| `GET /health` | liveness |
| `GET /site` | what the landing page shows: demo video URL and export formats (from `config.py`) |
| `POST /designs` | multipart `file` (PNG/JPG/SVG) + optional `settings` JSON (`{"width_mm": 60}`); validates, stores, returns an id, quality warnings (including "many small specks"), the detected colours and the removed background |
| `POST /designs/{id}/preview` | digitizes small PNG/JPG images on the spot (optional body: `width_mm`, `fill_row_spacing_mm`, `colours` to keep); returns stats, report, colour layers (image colour + thread placeholder), layers and every stitch as JSON |
| `GET /designs/{id}` | the stored design record |
| `GET /designs/{id}/shapes` | the design's colour layers and shapes in mm (outline + holes), each shape marked fill or satin: the editor's canvas and Layers |
| `GET /designs/{id}/download?format=dst` | the DST file |
| `GET /formats` | machine file formats that can be exported (written AND read back identically by pyembroidery), plus the others with the reason they are not offered |
| `GET /designs/{id}/editor` | everything the editor shows (shapes, satin columns in sewing order, every stitch, history, defaults) from one run with the changes in effect; also refreshes the DST |
| `POST /designs/{id}/edits` | one change: `set_type`, `set_pull_compensation`, `split`, `column` (from two outlines or two drawn edges); refused with a plain 422 if it cannot be made |
| `POST /designs/{id}/edits/undo`, `/redo` | step back or forward through the changes (409 if there is nothing to undo or redo) |
| `POST /designs/{id}/trace` | starts "Create satin columns" as a background job (RQ); returns the job |
| `GET /jobs/health` | whether background jobs can run: `{"status":"ok","workers":N}`, or 503 "Background jobs are not running…" when Redis can't be reached (within `jobs.redis_timeout_s`) |
| `GET /jobs/{id}` | job state: queued, running (progress, server started-at), done (numbered columns + edit points), failed (plain message), cancelled |
| `POST /jobs/{id}/cancel` | cancels a queued job, or stops a running one |

Errors are always `{"error": "<what to fix>"}`. Upload limits and preview size come from `config.py` (still placeholders); `STITCHBOOK_TEST_RUN_VALUES=1 make api` runs with the stand-in values for trying it out. Files are stored through `stitchbook_api.storage.Storage` (local disk now, in `STORAGE_DIR`).

```sh
curl -F file=@logo.png -F 'settings={"width_mm":60}' localhost:8000/designs
curl -X POST localhost:8000/designs/<id>/preview
curl -o logo.dst "localhost:8000/designs/<id>/download?format=dst"
```

From `web/` the original commands still work:

```sh
cd web
npm start                # Vite dev server, http://localhost:8080
npm run build            # type-check + production build into web/dist
npm run check:tokens     # no colour literals outside src/css/tokens.css
npm run check:ui         # screenshots + contrast/clipping audit → web/screenshots/
npm run e2e              # real API + Redis + worker + browser: Upload, Preview, editor tracing and tools → web/screenshots/e2e/
npm run test:trace       # editor "Create satin columns" card: states, polling back-off, hidden tab, cancel (mocked API)
npm run test:editor      # editor tools: stitch type, pull compensation, fabric preset, Split, Select Satin Columns, Draw edges, undo/redo, errors (mocked API)
npm run test:pages       # Privacy, Terms, Contact, Blog: render, footer links, "Not chosen yet" markers, blog empty state and a fixture post
npm run test:once        # dev server (React StrictMode): one preview / editor load per design at a time (mocked API)
```

To try the Upload and Preview screens locally: `STITCHBOOK_TEST_RUN_VALUES=1 make api` in one terminal and `make web` in another, then open http://localhost:8080/upload. Tracing in the editor (`/editor?design=<id>`, reached from Preview) also needs Redis and `make worker`.

## Config and environment

- `digitizer/src/digitizer/config.py` holds product numbers. Values not yet chosen are `"__CHOOSE__"`, and `Config.get()` raises `PlaceholderValueError` if code asks for one. `TEST_RUN_OVERRIDES` in the same file are stand-in values for the sample run and tests only.
- `.env` holds only connection strings and secrets. See `.env.example`, which lists every variable with a comment.

Project and design rules for contributors (and Claude) are in `CLAUDE.md`.
