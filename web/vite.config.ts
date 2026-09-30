import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// envDir is the repo root so VITE_API_URL can live in the one .env / .env.example.
export default defineConfig({
  plugins: [react()],
  envDir: "..",
  server: { port: 8080, strictPort: true },
  preview: { port: 8080, strictPort: true },
});
