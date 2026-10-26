import { useEffect, useState } from "preact/hooks";
import { Toggle } from "../options/components/controls";
import { send, type TabStatusResponse } from "../shared/messages";
import { formatTime } from "../shared/time";
import type { StatusCounts } from "../shared/types";
import type { YoloStatus } from "../shared/yolo";

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

export function yoloText(y: YoloStatus): string {
  if (!y.enabled) return "Finds new jobs matching your searches and applies to them in the background.";
  return [
    y.running ? `Applying: ${y.running}` : y.nextCheckAt ? `Next check ${formatTime(y.nextCheckAt)}` : "",
    `${y.appliedToday}/${y.cap} applied today`,
    y.queued ? `${y.queued} queued` : "",
    y.needsYou ? `${y.needsYou} need you` : "",
    y.paused,
  ]
    .filter(Boolean)
    .join(" · ");
}

const openOptions = (hash: string) =>
  void chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html#${hash}`) });

export function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [info, setInfo] = useState<TabStatusResponse | null>(null);
  const [msg, setMsg] = useState("");
  const [yolo, setYolo] = useState<YoloStatus | null>(null);

  const host = (() => {
    try {
      return new URL(tab?.url ?? "").hostname;
    } catch {
      return "";
    }
  })();

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
    void send({ type: "YOLO_STATUS" }).then(setYolo);
  }, []);

  const setYoloOn = async (enabled: boolean) => {
    await send({ type: "YOLO_SET", enabled });
    setYolo(await send({ type: "YOLO_STATUS" }));
  };

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

  const ready = info && info.keysTotal > 0 && info.model;

  return (
    <div class="popup">
      <h1 class="brand">
        <a href="https://github.com/ExxML/AutoApply" target="_blank" rel="noreferrer">
          <img src="/icons/48.png" alt="" width={24} height={24} /> AutoApply
        </a>
      </h1>
      <div class="host">{host || "No page"}</div>
      <div class="status" role="status">
        {statusText(info)}
      </div>
      <button type="button" class="btn primary" onClick={() => void fill()} disabled={!host}>
        Fill this page
      </button>
      {msg && <p class="err">{msg}</p>}
      <div class="meta">
        {ready ? "Ready" : "Setup needed"} · Model: {info?.model ?? "none"} · {info?.keysTotal ?? 0} keys ·{" "}
        {info?.keysHealthy ?? 0} healthy
      </div>
      {yolo && (
        <div class="yolo">
          {yolo.searches ? (
            <Toggle
              label="YOLO mode"
              help={yoloText(yolo)}
              checked={yolo.enabled}
              onChange={(v) => void setYoloOn(v)}
            />
          ) : (
            <p class="help">
              YOLO mode applies to new jobs for you.{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), openOptions("/yolo"))}>
                Add a job search to turn it on
              </a>
            </p>
          )}
        </div>
      )}
      <div class="links">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openOptions("/profile/personal");
          }}
        >
          Edit profile
        </a>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openOptions("/applications");
          }}
        >
          Applications
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
