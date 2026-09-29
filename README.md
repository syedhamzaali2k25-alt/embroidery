# Stitchbook

Browser-based embroidery digitizer: upload a PNG/JPG/SVG logo and get machine-ready embroidery files (DST first, then PES) plus a preview image. Stitchbook is a working name, set in `config/stitchbook.toml`.

Status: scaffolding only. The web screens are static mock-ups; the digitizer has no stitch logic yet.

## Layout

| Folder | What it is |
|---|---|
| `digitizer/` | Importable Python stitch library (`import digitizer`). No web code. |
| `api/` | FastAPI service (`stitchbook_api`), imports `digitizer`. |
| `worker/` | RQ job runner (`stitchbook_worker`), imports `digitizer`. |
| `web/` | Static front end (landing, home, editor) and its screenshot/contrast audit. |
| `config/stitchbook.toml` | The single file for every stitch number, limit, timeout and rate limit. |
| `docs/` | Project documentation. |

## Requirements

Python 3.11+, Node 18+, Redis (for the worker), GNU Make.

## Commands

```sh
cp .env.example .env     # then fill in values
make setup               # .venv with digitizer/api/worker (editable) + web npm install
make test                # pytest (empty suite passes) + web colour-token lint
make api                 # FastAPI on http://localhost:$API_PORT  (GET /health)
make worker              # RQ worker on $RQ_QUEUE, needs Redis at $REDIS_URL
make web                 # static front end on http://localhost:$WEB_PORT
```

From `web/` the original commands still work:

```sh
cd web
npm start                # http://localhost:8080
npm run check:tokens     # no colour literals outside css/tokens.css
npm run check:ui         # screenshots + contrast/clipping audit → web/screenshots/
```

## Config and environment

- `config/stitchbook.toml` holds product numbers. Values not yet chosen are `"__CHOOSE__"`, and `digitizer.config` raises `PlaceholderValueError` if code asks for one.
- `.env` holds only connection strings and secrets. See `.env.example`, which lists every variable with a comment.

Project and design rules for contributors (and Claude) are in `CLAUDE.md`.
