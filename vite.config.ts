import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import preact from "@preact/preset-vite";
import manifest from "./manifest.config.ts";

export default defineConfig({
  plugins: [
    preact(),
    // A standalone IIFE has no module loader. The default loader import()s the bundle from the page's context, which
    // a page's Connection-Allowlist header (YouTube's, report-only today) flags — and blocks once enforced.
    crx({ manifest, contentScripts: { standaloneFiles: ["src/content/index.ts"] } }),
  ],
  build: {
    target: "chrome120",
    outDir: "dist",
    emptyOutDir: true,
    // YOLO's hidden host page: loaded by chrome.offscreen, so not referenced by the manifest.
    rollupOptions: { input: { offscreen: "src/offscreen/index.html" } },
  },
});
