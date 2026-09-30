# Stitchbook web

Vite + React + TypeScript front end. Landing, Home and Editor were ported 1:1 from the original static pages (the screenshot audit showed them pixel-identical after the move).

| Screen  | File         | Notes |
|---------|--------------|-------|
| Landing | `/` (`src/pages/Landing.tsx`) | Plain white page, content centred at max width; pastel fills allowed |
| Home    | `/home` (`src/pages/Home.tsx`) | Designs dashboard; pastel quick-start cards and thumbnails |
| Editor  | `/editor` (`src/pages/Editor.tsx`) | Full-bleed white and neutral; ink and green are the only accents |

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
```

`npm run check:ui` builds the app, serves `dist/` and renders every screen at 1440×900 and 390×844 into `web/screenshots/`. It also writes `report.json` and flags these problems:

- text below WCAG contrast against its real background
- white text on anything other than ink
- clipped or off-screen text, and horizontal page scroll
- fonts that did not load

### Known contrast exception

The spec's green serif accent word (`#2ED47A`) on white measures **1.94:1**. That is below the WCAG 3:1 minimum for large text, so the audit reports it on every heading that has an accent word. Keeping it is a deliberate design-system decision. Everything else passes.
