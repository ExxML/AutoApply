// Copies the React 18 UMD builds (React 19 has none) into test/fixtures/vendor for the React fixtures.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export default function globalSetup() {
  const out = join(import.meta.dirname, "fixtures", "vendor");
  mkdirSync(out, { recursive: true });
  const mods = join(import.meta.dirname, "..", "node_modules");
  copyFileSync(join(mods, "react/umd/react.production.min.js"), join(out, "react.js"));
  copyFileSync(join(mods, "react-dom/umd/react-dom.production.min.js"), join(out, "react-dom.js"));
}
