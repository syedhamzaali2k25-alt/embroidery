// The one Node API vite.config.ts uses (reading config.py at build time). Declared here so the type
// check needs no @types/node dependency.
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
}
