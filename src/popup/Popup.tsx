import { useEffect, useState } from "preact/hooks";
import { send, type TabStatusResponse } from "../shared/messages";
import { createStorage } from "../shared/storage";
import type { Settings, StatusCounts } from "../shared/types";

const store = createStorage("popup");

export function statusText(r: TabStatusResponse | null): string {
  const frames = Object.values(r?.status?.frames ?? {});
  if (!frames.length) return "Not a job form";
  if (frames.some((f) => f.running)) return "Working…";
  const err = frames.find((f) => f.error)?.error;
  if (err) return `Error: ${err}`;
  const c = frames.reduce<StatusCounts>(
    (a, f) => {
      for (const k of Object.keys(a) as (keyof StatusCounts)[]) a[k] += f.counts[k];
      return a;
    },
    { total: 0, filled: 0, aiMatched: 0, aiDrafted: 0, needsYou: 0, failed: 0, prefilled: 0, skipped: 0 },
  );
  if (!c.total) return "Not a job form";
  const need = c.needsYou + c.failed;
  return `Filled ${c.filled}/${c.total}${need ? ` · ${need} need you` : ""}`;
}

export function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [info, setInfo] = useState<TabStatusResponse | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<Record<string, { autoFill: "on" | "off" }>>({});
  const [msg, setMsg] = useState("");

  const host = (() => {
    try {
      return new URL(tab?.url ?? "").hostname;
    } catch {
      return "";
    }
  })();

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
    void store.get("settings").then(setSettings);
    void store.get("siteRules").then(setRules);
  }, []);

  useEffect(() => {
    if (tab?.id === undefined) return;
    const load = () => void send({ type: "TAB_STATUS", tabId: tab.id! }).then(setInfo);
    load();
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [tab?.id]);

  const fill = async () => {
    if (tab?.id === undefined) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_FILL", force: true });
      setMsg("");
    } catch {
      setMsg("This page can't be filled (reload it, or it's a browser page).");
    }
  };

  const siteOn = rules[host] ? rules[host].autoFill === "on" : (settings?.autoFillOnDetect ?? true);
  const ready = info && info.keysTotal > 0 && info.model;

  return (
    <div class="popup">
      <div class="host">{host || "No page"}</div>
      <div class="status" role="status">
        {statusText(info)}
      </div>
      <button type="button" class="btn primary" onClick={() => void fill()} disabled={!host}>
        Fill this page
      </button>
      {msg && <p class="err">{msg}</p>}
      {host && (
        <div class="field toggle">
          <input
            id="site"
            type="checkbox"
            checked={siteOn}
            onChange={async (e) => {
              const next = {
                ...rules,
                [host]: { autoFill: e.currentTarget.checked ? ("on" as const) : ("off" as const) },
              };
              setRules(next);
              await store.set({ siteRules: next });
            }}
          />
          <label for="site">Auto-fill on this site</label>
        </div>
      )}
      {settings && (
        <div class="field toggle">
          <input
            id="global"
            type="checkbox"
            checked={settings.autoFillOnDetect}
            onChange={async (e) => {
              const next = { ...settings, autoFillOnDetect: e.currentTarget.checked };
              setSettings(next);
              await store.set({ settings: next });
            }}
          />
          <label for="global">Auto-fill on job pages</label>
        </div>
      )}
      <div class="meta">
        {ready ? "Ready" : "Setup needed"} · Model: {info?.model ?? "none"} · {info?.keysTotal ?? 0} keys ·{" "}
        {info?.keysHealthy ?? 0} healthy
      </div>
      <div class="links">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void chrome.tabs.create({ url: chrome.runtime.getURL("src/options/index.html#/profile/personal") });
          }}
        >
          Edit profile
        </a>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void chrome.runtime.openOptionsPage();
          }}
        >
          Settings
        </a>
      </div>
    </div>
  );
}
