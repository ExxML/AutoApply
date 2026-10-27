import { useEffect, useState } from "preact/hooks";
import { isErr, send } from "../../shared/messages";
import type { AiTask, ClaudeTask } from "../../shared/settings";
import type { Settings } from "../../shared/types";
import { installerScript, setupCommand, uninstallCommand, type SetupOs } from "../claudeSetup";
import { save, useStored } from "../store";

const PROVIDERS: [Settings["aiProvider"], string, string][] = [
  [
    "gemini",
    "Gemini",
    "Free API keys from Google AI Studio. Calls go directly from your browser to Google Gemini; keys are sent only to Google, never to web pages or content scripts.",
  ],
  [
    "claude",
    "Claude",
    "Your Claude Pro or Max plan, through Claude Code on this computer. No API key; usage counts against your plan's limits.",
  ],
];

/** Which AI answers every feature: autofill, essays, cover letters, résumé import and YOLO. */
export function ProviderPicker() {
  const s = useStored("settings");
  if (!s) return null;
  return (
    <section class="panel-box">
      <h2>Provider</h2>
      <div class="seg" role="radiogroup" aria-label="AI provider">
        {PROVIDERS.map(([v, t]) => (
          <button
            type="button"
            role="radio"
            aria-checked={s.aiProvider === v}
            class={s.aiProvider === v ? "on" : ""}
            onClick={() => void save({ settings: { ...s, aiProvider: v } })}
          >
            {t}
          </button>
        ))}
      </div>
      <p class="help">{PROVIDERS.find(([v]) => v === s.aiProvider)?.[2]}</p>
    </section>
  );
}

type Check = { state: "busy" | "ok" | "err"; text: string } | null;

export function ClaudeConnect() {
  const ready = useStored("claudeReady");
  const [os, setOs] = useState<SetupOs | "unsupported">();
  const [copied, setCopied] = useState(false);
  const [check, setCheck] = useState<Check>(null);
  useEffect(() => {
    void chrome.runtime
      .getPlatformInfo()
      .then(({ os }) => setOs(os === "win" || os === "mac" || os === "linux" ? os : "unsupported"));
  }, []);
  if (!os) return null;
  if (os === "unsupported")
    return (
      <section class="panel-box">
        <h2>Connect Claude Code</h2>
        <p class="err">Claude needs Windows, macOS or Linux: Claude Code doesn't run on this device.</p>
      </section>
    );
  const id = chrome.runtime.id;
  const command = setupCommand(os, id);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };
  const connect = async () => {
    // First, inside the click: Chrome only shows the permission prompt for a user gesture.
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] }).catch(() => false);
    if (!granted) return setCheck({ state: "err", text: "✗ AutoApply needs that permission to talk to Claude Code." });
    setCheck({ state: "busy", text: "Asking Claude Code…" });
    const r = await send({ type: "CLAUDE_TEST" });
    setCheck(
      isErr(r)
        ? { state: "err", text: `✗ ${r.error.message}` }
        : { state: "ok", text: `✓ Connected · ${r.model} · answered in ${(r.ms / 1000).toFixed(1)} s` },
    );
  };

  return (
    <section class="panel-box">
      <h2>Connect Claude Code</h2>
      <p>
        AutoApply runs Claude Code, Anthropic's app for your terminal, signed in with your own Claude plan. Your sign-in
        stays inside Claude Code: AutoApply only hands it prompts, with its tools, plugins and memory switched off and
        nothing saved.
      </p>
      <ol class="claude-steps">
        <li>
          <b>Install Claude Code and sign in.</b> Follow the{" "}
          <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
            install guide
          </a>
          , then run <code>claude</code> once in a terminal and sign in with your Claude account.
        </li>
        <li>
          <b>Install AutoApply's bridge to it.</b> Paste this into {os === "win" ? "PowerShell" : "Terminal"} and press
          Enter:
          <pre class="cmd">{command}</pre>
          <button type="button" class="btn small" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy command"}
          </button>
          <details>
            <summary>What this runs</summary>
            <pre class="cmd tall">{installerScript(os, id)}</pre>
          </details>
          <details>
            <summary>Uninstall</summary>
            <pre class="cmd">{uninstallCommand(os)}</pre>
          </details>
        </li>
        <li>
          <b>Connect.</b> Chrome asks once to let AutoApply talk to apps on this computer.{" "}
          <button
            type="button"
            class="btn primary small"
            disabled={check?.state === "busy"}
            onClick={() => void connect()}
          >
            {ready ? "Test connection" : "Connect"}
          </button>
          {check ? (
            <p class={check.state === "err" ? "err" : check.state === "ok" ? "ok" : "muted"} role="status">
              {check.text}
            </p>
          ) : (
            ready && <p class="ok">✓ Connected</p>
          )}
        </li>
      </ol>
    </section>
  );
}

const MODELS: [ClaudeTask["model"], string][] = [
  ["", "Default"],
  ["haiku", "Haiku (fastest)"],
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["fable", "Fable (may use usage credits)"],
];
const EFFORTS: [ClaudeTask["effort"], string][] = [
  ["", "Default"],
  ["low", "Low (fastest)"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
];
const TASKS: [AiTask, string, string][] = [
  [
    "fill",
    "Autofill & YOLO screening",
    "Field answers, dropdown picks, the answer check, and YOLO's job relevance check. A fill waits on these.",
  ],
  ["write", "Essays & cover letters", "Drafted essay answers and tailored cover letter PDFs."],
  ["resume", "Résumé import", "Reading your résumé into the profile (Prefill)."],
];

export function ClaudeModels() {
  const s = useStored("settings");
  if (!s) return null;
  const set = (task: AiTask, patch: Partial<ClaudeTask>) =>
    void save({ settings: { ...s, claude: { ...s.claude, [task]: { ...s.claude[task], ...patch } } } });
  return (
    <section class="panel-box">
      <h2>Models</h2>
      <p>
        A model and effort for each kind of work; Default uses Claude Code's own setting. Haiku at Low effort answers
        fastest; larger models and higher effort are slower and use more of your plan's limits.
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>Work</th>
            <th>Model</th>
            <th>Effort</th>
          </tr>
        </thead>
        <tbody>
          {TASKS.map(([k, label, help]) => (
            <tr>
              <td>
                {label}
                <div class="help">{help}</div>
              </td>
              <td>
                <select
                  aria-label={`${label}: model`}
                  value={s.claude[k].model}
                  onChange={(e) => set(k, { model: e.currentTarget.value as ClaudeTask["model"] })}
                >
                  {MODELS.map(([v, t]) => (
                    <option value={v}>{t}</option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  aria-label={`${label}: effort`}
                  value={s.claude[k].effort}
                  onChange={(e) => set(k, { effort: e.currentTarget.value as ClaudeTask["effort"] })}
                >
                  {EFFORTS.map(([v, t]) => (
                    <option value={v}>{t}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
