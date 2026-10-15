import { defineManifest } from "@crxjs/vite-plugin";

// match_origin_as_fallback is missing from the CRXJS manifest type; a non-literal object skips that check.
const contentScript = {
  matches: ["<all_urls>"],
  js: ["src/content/index.ts"],
  run_at: "document_idle" as const,
  all_frames: true,
  match_about_blank: true,
  match_origin_as_fallback: true,
};

export default defineManifest({
  manifest_version: 3,
  name: "AutoApply",
  version: "1.0.0",
  description: "Autofills job applications on any site using your profile.",
  minimum_chrome_version: "120",
  action: { default_popup: "src/popup/index.html", default_title: "AutoApply" },
  options_page: "src/options/index.html",
  background: { service_worker: "src/background/sw.ts", type: "module" },
  content_scripts: [contentScript],
  permissions: ["storage", "unlimitedStorage", "scripting", "webNavigation", "tabs"],
  host_permissions: ["<all_urls>"],
  commands: {
    "fill-page": {
      suggested_key: { default: "Alt+Shift+F" },
      description: "Fill the job application on this page",
    },
  },
  icons: { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" },
});
