import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// envDir is the repo root so VITE_API_URL can live in the one .env / .env.example.
export default defineConfig(({ mode }) => {
  // Blog posts are Markdown files in content/blog/. STITCHBOOK_BLOG_DIR (relative to web/) points
  // the build at another folder: only the page tests use it, with a fixture post (none is shipped).
  const env = loadEnv(mode, "..", "STITCHBOOK_");
  const blogDir = new URL(`${(env.STITCHBOOK_BLOG_DIR || "content/blog").replace(/\/$/, "")}/`, new URL("./", import.meta.url));
  // Sign-in (Supabase Auth). Only these two values reach the browser, named one by one: the
  // project URL and the publishable key. The secret key is never read here (see
  // scripts/check-bundle-secrets.mjs). `--mode offline` (the browser tests) builds without
  // sign-in, matching the API's local mode.
  const supabase = loadEnv(mode, "..", "SUPABASE_");
  const offline = mode === "offline";
  return {
    plugins: [react()],
    resolve: { alias: { "@blog": decodeURIComponent(blogDir.pathname).replace(/\/$/, "") } },
    envDir: "..",
    define: {
      "import.meta.env.STITCHBOOK_SUPABASE_URL": JSON.stringify(offline ? "" : supabase.SUPABASE_URL || ""),
      "import.meta.env.STITCHBOOK_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(offline ? "" : supabase.SUPABASE_PUBLISHABLE_KEY || ""),
    },
    server: { port: 8080, strictPort: true },
    preview: { port: 8080, strictPort: true },
  };
});
