# CLAUDE.md

## Project rules

Project: browser-based embroidery digitizer (working name Stitchbook, kept in one config value). Input: a PNG/JPG/SVG logo. Output: machine-ready embroidery files (DST first, PES second; JEF, VP3 and EXP only after a pyembroidery write-then-read round-trip test passes for each) plus a preview image.
Stack: Python 3, pyembroidery, shapely, opencv-python-headless, numpy, pillow, matplotlib; FastAPI; Redis with RQ; Supabase (Postgres, Auth, Storage); the web app in `web/` follows the existing static screens as its design reference.
Rules: build only the current step. Do not invent stitch parameters: put every number (density, max stitch length, underlay spacing, pull compensation, file size limits, timeouts, rate limits) in one config file with a comment on what it does, and leave unknown values as marked placeholders for me to choose. Never invent marketing claims (prices, speed, counts, ratings, testimonials, free plans); use a visible placeholder. After building, run the tests, and for stitch output read the DST back with pyembroidery and report stitch count, design size in mm and longest stitch. Say plainly what you could not verify. I will sew the output on a real machine and report back.

## Design system

Light UI: a plain white page with the content centred at a fixed max width; no gradient background and no floating card around the page.
Colours: green #2ED47A, lavender #C8B8F4, lime #DCFAB2, pink #F9B8E6, ink #1F1F1F, muted #8A8A8A, line #EDEDED, white #FFFFFF. Page background: white. Green is for fills only; for green text on white define a separate darker token and choose its value so the audit shows at least 3:1 for large text and 4.5:1 for small text.
Text on green, lavender, lime and pink is always ink, never white. White text only on ink buttons.
Fonts: DM Sans 400/500/700 for UI and headings; DM Serif Display 400 only for one accent word per heading. Both self-hosted.
Shape: buttons are pills; cards use a 22-26px radius; thumbnails cycle green, lavender, lime, pink.
The editor stays mostly white and neutral with ink and green as the only accents. Pastel fills belong on the landing page and Home only.
Every colour is defined once as a CSS variable; no colour literals outside the tokens file. Artwork is original; never copy a third-party template's layout, logo or copy.
After building any screen, run the screenshot audit and fix clipped text and contrast before reporting.

## Folder rules

- `digitizer/`: importable stitch library (`import digitizer`). All stitch logic lives here. No web code: no FastAPI, no RQ, no HTTP, no HTML.
- `api/`: FastAPI service (`stitchbook_api`). Imports `digitizer/`; never copies or re-implements its logic.
- `worker/`: RQ job runner (`stitchbook_worker`). Imports `digitizer/`; never copies or re-implements its logic.
- `web/`: static front end and its checks (`npm start`, `npm run check:tokens`, `npm run check:ui`). Colour tokens live in `web/src/css/tokens.css`.
- `supabase/`: plain SQL migrations in `supabase/migrations/` (the owner pastes them into the SQL Editor in file-name order; see `docs/supabase-setup.md`) and `supabase/tests/` (the RLS and Storage policies tested on a throwaway local Postgres). Never change the live project from code or an MCP; write a new migration file instead.
- `docs/`: project documentation.
- `digitizer/src/digitizer/config.py`: the one config file. All stitch numbers, size limits, timeouts and rate limits live here, each with a comment. Unchosen values stay `"__CHOOSE__"`. Python code reads them only through `digitizer.config`, which refuses to return a placeholder.
- `.env` / `.env.example`: connection strings and secrets only, never product numbers. `.env.example` lists every variable the code reads, all empty (`api/tests/test_env_example.py`); `.env` is gitignored and never printed or committed.

## Accounts and data (Supabase)

- Every table has an owner (`owner_id uuid not null references auth.users on delete cascade`; `profiles.id` is the user id), RLS on, four owner-only policies `to authenticated` on `(select auth.uid())`, an index on `owner_id`, and nothing for anon. A new table follows the same pattern and gets a test in `supabase/tests/test_rls.py`.
- Storage: private buckets only (`uploads`, `exports`), object path `{user_id}/{design_id}/{file}`, owner-folder policies, short-lived signed URLs (`storage.signed_url_ttl_s`), never public URLs.
- API: the user id comes only from the verified Supabase token, never from the request; missing or bad token 401, someone else's design or job 404. Every route except `/health`, `/site`, `/formats`, `/config` takes `designs: Designs = Depends(my_designs)` (or `current_user`); `api/tests/test_auth.py` walks every route, so a new route without it fails. The API acts as the user (publishable key + their token), never with the secret key.
- Web: only `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and the public `VITE_GOOGLE_CLIENT_ID` reach the browser (named in `web/vite.config.ts`); the Google client secret lives only in the Supabase dashboard, never in the repo. Google sign-in: redirect with PKCE back to `/login`, and One Tap with a SHA-256 nonce (never turn off Supabase's nonce check); the Google script loads only on Log in and Sign up, only with a client ID, only when signed out; `npm run build` ends with `check:secrets`. Browser tests build with `--mode offline` (no sign-in); `npm run test:auth` covers the sign-in build.
- Without the Supabase settings the API and web run in local mode (one local user, files on disk) so every offline test passes. Live isolation tests (`api/tests/test_supabase_live.py`) skip with a message when the keys are missing; say so when reporting.
- Security and Performance Advisors cannot be run from here: findings go in `docs/supabase-advisors.md`; never claim they are clean.
