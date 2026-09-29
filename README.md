# Stitchbook

Browser-based embroidery digitizer: upload a PNG/JPG/SVG logo and get machine-ready embroidery files (DST first, then PES) plus a preview image. Stitchbook is a working name, set in `digitizer/src/digitizer/config.py`.

Status: the digitizer turns a single-colour PNG/JPG logo into a DST and a preview. Wide shapes get fill; narrow shapes get satin columns with edge-walk/zigzag underlay and pull compensation. Where satin strokes meet, the columns stop short and a small fill patch covers the junction. No lock stitches, fill underlay or colours yet. The API accepts uploads (with validation and quality warnings), digitizes small images on request and serves the DST. The web screens are static mock-ups, and the worker does not run jobs yet.

## Layout

| Folder | What it is |
|---|---|
| `digitizer/` | Importable Python stitch library (`import digitizer`). No web code. |
| `api/` | FastAPI service (`stitchbook_api`), imports `digitizer`. |
| `worker/` | RQ job runner (`stitchbook_worker`), imports `digitizer`. |
| `web/` | Static front end (landing, home, editor) and its screenshot/contrast audit. |
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
make web                 # static front end on http://localhost:$WEB_PORT
```

Digitizer (inside the venv):

```sh
.venv/bin/python -m digitizer.digitize logo.png --out outdir   # needs every stitch value chosen in config.py
.venv/bin/python -m digitizer.digitize logo.png --out outdir --test-run-values   # stand-in values, not for sewing
.venv/bin/python -m digitizer.digitize logo.png --out outdir --width-mm 30        # design width for this job
.venv/bin/python -m digitizer.readback outdir/out.dst          # stitch count, size, longest stitch (+ report.json beside it)
.venv/bin/python digitizer/samples/make_samples.py             # regenerate the sample logos
.venv/bin/python digitizer/samples/run_samples.py              # digitize all samples, print DST readback
```

API (see http://localhost:$API_PORT/docs for the full schema):

| Endpoint | What it does |
|---|---|
| `GET /health` | liveness |
| `POST /designs` | multipart `file` (PNG/JPG/SVG) + optional `settings` JSON (`{"width_mm": 60}`); validates, stores, returns an id and quality warnings |
| `POST /designs/{id}/preview` | digitizes small PNG/JPG images on the spot, returns stats, report and every stitch as JSON |
| `GET /designs/{id}` | the stored design record |
| `GET /designs/{id}/download?format=dst` | the DST file |

Errors are always `{"error": "<what to fix>"}`. Upload limits and preview size come from `config.py` (still placeholders); `STITCHBOOK_TEST_RUN_VALUES=1 make api` runs with the stand-in values for trying it out. Files are stored through `stitchbook_api.storage.Storage` (local disk now, in `STORAGE_DIR`).

```sh
curl -F file=@logo.png -F 'settings={"width_mm":60}' localhost:8000/designs
curl -X POST localhost:8000/designs/<id>/preview
curl -o logo.dst "localhost:8000/designs/<id>/download?format=dst"
```

From `web/` the original commands still work:

```sh
cd web
npm start                # http://localhost:8080
npm run check:tokens     # no colour literals outside css/tokens.css
npm run check:ui         # screenshots + contrast/clipping audit → web/screenshots/
```

## Config and environment

- `digitizer/src/digitizer/config.py` holds product numbers. Values not yet chosen are `"__CHOOSE__"`, and `Config.get()` raises `PlaceholderValueError` if code asks for one. `TEST_RUN_OVERRIDES` in the same file are stand-in values for the sample run and tests only.
- `.env` holds only connection strings and secrets. See `.env.example`, which lists every variable with a comment.

Project and design rules for contributors (and Claude) are in `CLAUDE.md`.
