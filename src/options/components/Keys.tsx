import { useState } from "preact/hooks";
import { keyStatusText } from "../../background/gemini/keyPool";
import { isErr, send } from "../../shared/messages";
import { save, useStored } from "../store";

export const QUOTA_NOTE =
  "Rate limits apply per Google Cloud project, not per key. Keys created in the same project share one quota.";

const mask = (k: string) => `••••${k.slice(-4)}`;

export function Keys() {
  const keys = useStored("apiKeys") ?? [];
  const state = useStored("keyState") ?? {};
  const model = useStored("selectedModel") ?? null;
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});

  const add = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await send({ type: "ADD_KEY", label, key });
    setBusy(false);
    if (isErr(r)) setMsg({ ok: false, text: r.error.message });
    else {
      setMsg({ ok: true, text: "Key added and verified." });
      setLabel("");
      setKey("");
    }
  };

  const test = async (id: string) => {
    setRowMsg((m) => ({ ...m, [id]: "Testing…" }));
    const r = await send({ type: "TEST_KEY", id });
    setRowMsg((m) => ({ ...m, [id]: isErr(r) ? `✗ ${r.error.message}` : "✓ Works" }));
  };

  const remove = (id: string) => void save({ apiKeys: keys.filter((k) => k.id !== id) });

  return (
    <section class="panel-box">
      <h2>API keys</h2>
      <p>
        Get a free key at{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          aistudio.google.com/apikey
        </a>
        . Add several keys to rotate automatically when one hits a rate limit.
      </p>
      <p class="note">{QUOTA_NOTE}</p>
      {keys.length > 0 && (
        <table class="table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Key</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const status = keyStatusText(state[k.id], model);
              return (
                <tr>
                  <td>{k.label}</td>
                  <td class="mono">{mask(k.key)}</td>
                  <td>
                    <span class={`chip ${status === "Healthy" ? "good" : status === "Invalid key" ? "bad" : "warn"}`}>
                      {status}
                    </span>
                    {rowMsg[k.id] && <div class="help">{rowMsg[k.id]}</div>}
                  </td>
                  <td class="row-actions">
                    <button type="button" class="btn small" onClick={() => void test(k.id)}>
                      Test
                    </button>
                    <button type="button" class="btn small danger" onClick={() => remove(k.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <form class="inline-form" onSubmit={add}>
        <label>
          Label
          <input value={label} placeholder="e.g. Project A" onInput={(e) => setLabel(e.currentTarget.value)} />
        </label>
        <label>
          API key
          <input
            type="password"
            autocomplete="off"
            value={key}
            placeholder="AIza…"
            onInput={(e) => setKey(e.currentTarget.value)}
            required
          />
        </label>
        <button class="btn primary" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Add key"}
        </button>
      </form>
      {msg && (
        <p class={msg.ok ? "ok" : "err"} role="status">
          {msg.text}
        </p>
      )}
    </section>
  );
}
