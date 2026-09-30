# Stitchbook web

Vite + React + TypeScript front end. Landing, Home and Editor were ported 1:1 from the original static pages (the screenshot audit showed them pixel-identical after the move).

| Screen  | File         | Notes |
|---------|--------------|-------|
| Landing | `/` (`src/pages/Landing.tsx`) | Plain white page, content centred at max width; pastel fills allowed |
| Home    | `/home` (`src/pages/Home.tsx`) | Designs dashboard; pastel quick-start cards and thumbnails |
| Editor  | `/editor` (`src/pages/Editor.tsx`) | Full-bleed white and neutral; ink and green are the only accents |
| Upload  | `/upload` (`src/pages/Upload.tsx`) | Uses the API: upload, quality messages, design width. White and neutral like the editor |
| Preview | `/preview/:id` (`src/pages/Preview.tsx`) | Uses the API: real stitch lines, summary, layers, DST download |

## Design system

- **Tokens**: every colour is defined once in `src/css/tokens.css` and used through `var(--…)`. `npm run check:tokens` fails on any colour literal anywhere else.
- **Text on fills**: text on green, lavender, lime and pink is always `--ink` (`--on-fill`). White text (`--on-ink`) is used only on ink buttons and ink-selected controls.
- **Type**: DM Sans 400/500/700 for UI and headings; DM Serif Display 400 only on the single `.accent` word in a heading, in green. Both are self-hosted in `src/assets/fonts` (SIL OFL 1.1).
- **Shape**: buttons are pills (`--radius-pill`); cards use 22/24/26px radii. `.thumbs > :nth-child(4n+…)` cycles design thumbnails through green, lavender, lime and pink.
- **Artwork**: the star, sparkle, blob, stitch motifs and icons in `public/assets/sprite.svg` are original and take their colour from `currentColor`.

## Run and check

```sh
npm install
npm start            # Vite dev server, http://localhost:8080
npm run build        # type-check + build into dist/
npm run check        # token lint + screenshots and UI audit
npm run e2e          # real API (../.venv) + Chromium, three test images, desktop and phone
```

`npm run check:ui` builds the app, serves `dist/` and renders every screen at 1440×900 and 390×844 into `web/screenshots/`. It also writes `report.json` and flags these problems:

- text below WCAG contrast against its real background
- white text on anything other than ink
- clipped or off-screen text, and horizontal page scroll
- fonts that did not load

### Known contrast exception

The spec's green serif accent word (`#2ED47A`) on white measures **1.94:1**. That is below the WCAG 3:1 minimum for large text, so the audit reports it on every heading that has an accent word. Keeping it is a deliberate design-system decision. Everything else passes.

### Landing

- The hero's dashed upload box hands the dropped (or chosen) file straight to the Upload screen.
- Export formats and the demo video come from `config.py` through `GET /site`: `output.formats` lists only formats whose round-trip test passes (DST today), and an empty `site.demo_video_url` shows a poster labelled "[Demo video]".
- Unconfirmed terms stay visible placeholders: "[Fill in your trial terms]" (FAQ), "[Export formats]" (only if the API can't be reached), "[Plan details]" (Home).

### Upload and Preview

- API address: `VITE_API_URL` (default `http://localhost:8000`), read from the repo-root `.env`.
- Every number on these screens comes from the API response; nothing is sample data.
- `check:ui` audits both screens in every state (empty, checked, error, loading) using API responses recorded by `npm run e2e` in `scripts/fixtures/`.
- `scripts/test-images/` holds the three test logos (made by `scripts/make-test-images.mjs`).
- Not wired yet, and labelled as such on screen: **Remove background** (always on) and **Colours to keep** (one thread colour for now). The editor is still a mock-up and does not load the design.
