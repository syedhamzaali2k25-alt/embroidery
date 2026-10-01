import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// envDir is the repo root so VITE_API_URL can live in the one .env / .env.example.
export default defineConfig(({ mode }) => {
  // Blog posts are Markdown files in content/blog/. STITCHBOOK_BLOG_DIR (relative to web/) points
  // the build at another folder: only the page tests use it, with a fixture post (none is shipped).
  const env = loadEnv(mode, "..", "STITCHBOOK_");
  const blogDir = new URL(`${(env.STITCHBOOK_BLOG_DIR || "content/blog").replace(/\/$/, "")}/`, new URL("./", import.meta.url));
  return {
    plugins: [react()],
    resolve: { alias: { "@blog": decodeURIComponent(blogDir.pathname).replace(/\/$/, "") } },
    envDir: "..",
    server: { port: 8080, strictPort: true },
    preview: { port: 8080, strictPort: true },
  };
});
