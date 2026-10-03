// The product name and the build's placeholder switch, set at build time (vite.config.ts).

/** config.py's app.name: the only place the product name is defined. */
export const APP_NAME = import.meta.env.STITCHBOOK_APP_NAME as string;

/** Development and test builds show the owner's open decisions as visible placeholders; a
 *  production build leaves them off the public pages. */
export const SHOW_PLACEHOLDERS = Boolean(import.meta.env.STITCHBOOK_SHOW_PLACEHOLDERS);

/** "<page> · <product>" for document titles. */
export const titled = (page: string) => `${page} · ${APP_NAME}`;
