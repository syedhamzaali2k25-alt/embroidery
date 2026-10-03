import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** The product name: config.py's one value (PRODUCT["app"]["name"]), read at build time so the
 *  header, footer and titles never type it in (npm run test:landing checks the built title against
 *  the value Python reads). */
export function appName(): string {
  const config = readFileSync(new URL("../digitizer/src/digitizer/config.py", import.meta.url), "utf8");
  const name = config.match(/"app":\s*\{[^}]*?"name":\s*"([^"]+)"/)?.[1];
  if (!name) throw new Error("app.name not found in digitizer/src/digitizer/config.py");
  return name;
}

/** Preloads the self-hosted fonts (their hashed build names), so text does not reflow when they arrive. */
function preloadFonts(): Plugin {
  return {
    name: "stitchbook-preload-fonts",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter((f) => f.endsWith(".woff2"));
        return { html: html.replaceAll("%APP_NAME%", appName()),
          tags: fonts.map((f) => ({ tag: "link", injectTo: "head-prepend" as const,
            attrs: { rel: "preload", href: `/${f}`, as: "font", type: "font/woff2", crossorigin: "" } })) };
      },
    },
  };
}

// envDir is the repo root so VITE_API_URL can live in the one .env / .env.example.
export default defineConfig(({ mode }) => {
  // Blog posts are Markdown files in content/blog/. STITCHBOOK_BLOG_DIR (relative to web/) points
  // the build at another folder: only the page tests use it, with a fixture post (none is shipped).
  const env = loadEnv(mode, "..", "STITCHBOOK_");
  const blogDir = new URL(`${(env.STITCHBOOK_BLOG_DIR || "content/blog").replace(/\/$/, "")}/`, new URL("./", import.meta.url));
  // Sign-in (Supabase Auth). Only these values reach the browser, named one by one: the project
  // URL, the publishable key and the public Google client ID. The secret key is never read here
  // (see scripts/check-bundle-secrets.mjs). `--mode offline` (the browser tests) builds without
  // sign-in, matching the API's local mode.
  const supabase = loadEnv(mode, "..", "SUPABASE_");
  // Google One Tap: the OAuth client ID is public. The Google client secret is never read here
  // (it lives only in the Supabase dashboard).
  const google = loadEnv(mode, "..", "VITE_GOOGLE_");
  const offline = mode === "offline";
  return {
    plugins: [react(), preloadFonts()],
    resolve: { alias: { "@blog": decodeURIComponent(blogDir.pathname).replace(/\/$/, "") } },
    envDir: "..",
    define: {
      "import.meta.env.STITCHBOOK_SUPABASE_URL": JSON.stringify(offline ? "" : supabase.SUPABASE_URL || ""),
      "import.meta.env.STITCHBOOK_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(offline ? "" : supabase.SUPABASE_PUBLISHABLE_KEY || ""),
      "import.meta.env.VITE_GOOGLE_CLIENT_ID": JSON.stringify(offline ? "" : google.VITE_GOOGLE_CLIENT_ID || ""),
      "import.meta.env.STITCHBOOK_APP_NAME": JSON.stringify(appName()),
      // Owner-decision placeholders ("Not chosen yet", "[Refund policy]", ...) show in development
      // and test builds only; a production build (plain `vite build`) leaves them out of public pages.
      "import.meta.env.STITCHBOOK_SHOW_PLACEHOLDERS": JSON.stringify(mode !== "production"),
    },
    server: { port: 8080, strictPort: true },
    preview: { port: 8080, strictPort: true },
  };
});
