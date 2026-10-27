// The one-time terminal command that installs the Claude bridge (src/native) and registers it with the browsers.
import { BRIDGE_HOST } from "../background/claude/bridge";
import { toBase64 } from "../shared/base64";
import hostPs1 from "../native/host.ps1?raw";
import hostSh from "../native/host.sh?raw";

export type SetupOs = "win" | "mac" | "linux";

const b64 = (s: string) => toBase64(new TextEncoder().encode(s));
const NOT_FOUND =
  "Claude Code isn't installed (or isn't on PATH): install it from https://code.claude.com/docs/en/setup, sign in, then run this again.";
const DONE = "AutoApply can now use Claude Code. Go back to AutoApply and click Test connection.";

const WIN_DIR = "$env:LOCALAPPDATA\\AutoApply\\claude-bridge";
const WIN_KEYS = ["Google\\Chrome", "Microsoft\\Edge", "Chromium", "BraveSoftware\\Brave-Browser"];
const UNIX_DIR = "$HOME/.autoapply/claude-bridge";
/** Each browser's user-level NativeMessagingHosts parent; only the ones that exist get the manifest. */
const BROWSER_DIRS: Record<"mac" | "linux", string[]> = {
  mac: ["Google/Chrome", "Microsoft Edge", "Chromium", "BraveSoftware/Brave-Browser"].map(
    (b) => `$HOME/Library/Application Support/${b}`,
  ),
  linux: ["google-chrome", "microsoft-edge", "chromium", "BraveSoftware/Brave-Browser"].map(
    (b) => `$HOME/.config/${b}`,
  ),
};

const manifest = (id: string, path: string) =>
  JSON.stringify({
    name: BRIDGE_HOST,
    description: "AutoApply bridge to Claude Code", // no apostrophe: it sits in single-quoted shell strings
    path,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  });

/** The readable installer script (shown under "What this runs"). */
export function installerScript(os: SetupOs, id: string): string {
  if (os === "win")
    return [
      `$c = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source`,
      `if (-not $c) { Write-Host "${NOT_FOUND}" -ForegroundColor Red } else {`,
      `  $d = "${WIN_DIR}"`,
      `  New-Item -ItemType Directory -Force $d | Out-Null`,
      `  [IO.File]::WriteAllText("$d\\host.ps1", @'\n${hostPs1.replace(/\r?\n$/, "")}\n'@)`,
      `  [IO.File]::WriteAllText("$d\\host.cmd", '@powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0host.ps1"')`,
      `  [IO.File]::WriteAllText("$d\\claude-path.txt", $c)`,
      // Windows allows a path relative to the manifest
      `  [IO.File]::WriteAllText("$d\\${BRIDGE_HOST}.json", '${manifest(id, "host.cmd")}')`,
      `  foreach ($b in ${WIN_KEYS.map((k) => `'${k}'`).join(", ")}) {`,
      `    reg add "HKCU\\Software\\$b\\NativeMessagingHosts\\${BRIDGE_HOST}" /ve /d "$d\\${BRIDGE_HOST}.json" /f | Out-Null`,
      `  }`,
      `  Write-Host "${DONE}" -ForegroundColor Green`,
      `}`,
    ].join("\n");
  return [
    `set -e`,
    `c=$(command -v claude || true)`,
    `if [ -z "$c" ]; then echo "${NOT_FOUND}"; exit 1; fi`,
    `d="${UNIX_DIR}"`,
    `mkdir -p "$d"`,
    `cat > "$d/host.sh" <<'AUTOAPPLY_HOST'\n${hostSh.replace(/\r?\n$/, "")}\nAUTOAPPLY_HOST`,
    `chmod +x "$d/host.sh"`,
    `printf %s "$c" > "$d/claude-path"`,
    `m='${manifest(id, "__PATH__")}'`,
    `for b in ${BROWSER_DIRS[os].map((p) => `"${p}"`).join(" ")}; do`,
    `  if [ -d "$b" ]; then`,
    `    mkdir -p "$b/NativeMessagingHosts"`,
    `    printf '%s' "$m" | sed "s#__PATH__#$d/host.sh#" > "$b/NativeMessagingHosts/${BRIDGE_HOST}.json"`,
    `  fi`,
    `done`,
    `echo "${DONE}"`,
  ].join("\n");
}

/** What the user pastes: the installer, encoded so no shell (PowerShell, bash, zsh, fish) mangles its quoting. */
export function setupCommand(os: SetupOs, id: string): string {
  const s = installerScript(os, id);
  return os === "win"
    ? `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}')))`
    : `printf '%s' '${b64(s)}' | base64 --decode | sh`;
}

export function uninstallCommand(os: SetupOs): string {
  if (os === "win")
    return `Remove-Item -Recurse -Force "${WIN_DIR}" -ErrorAction SilentlyContinue; foreach ($b in ${WIN_KEYS.map((k) => `'${k}'`).join(", ")}) { reg delete "HKCU\\Software\\$b\\NativeMessagingHosts\\${BRIDGE_HOST}" /f 2>&1 | Out-Null }`;
  return `rm -rf "${UNIX_DIR}" ${BROWSER_DIRS[os].map((p) => `"${p}/NativeMessagingHosts/${BRIDGE_HOST}.json"`).join(" ")}`;
}
