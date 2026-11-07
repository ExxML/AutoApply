import { useEffect, useRef, useState } from "preact/hooks";
import { normalize } from "../../shared/normalize";
import type { QueueItem } from "../../shared/yolo";
import { store } from "../store";

/** Keep the queue off the application history, with native modal focus and Escape handling. */
export function QueuedJobs({ queue }: { queue: QueueItem[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const panel = dialog.current!;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    panel.showModal();
    return () => {
      if (panel.open) panel.close();
      root.style.overflow = overflow;
    };
  }, [open]);

  const remove = async (key?: string) => {
    setBusy(true);
    setError("");
    try {
      // Read at action time: discovery and YOLO may have changed the queue while the panel was open.
      await store.set({
        yoloQueue: key === undefined ? [] : (await store.get("yoloQueue")).filter((i) => i.key !== key),
      });
      search.current?.focus({ preventScroll: true });
    } catch {
      setError("Couldn't update the queue. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const nq = normalize(q);
  // A closed panel does not build a potentially large job list.
  const rows = open
    ? queue.filter((i) => !nq || normalize(`${i.company} ${i.title} ${i.source} ${i.location}`).includes(nq))
    : [];

  return (
    <>
      <button
        type="button"
        class="btn queue-trigger"
        aria-haspopup="dialog"
        aria-controls="queued-jobs"
        onClick={() => {
          setQ("");
          setError("");
          setOpen(true);
        }}
      >
        Queued jobs <span class="queue-count">{queue.length}</span>
      </button>
      <dialog
        ref={dialog}
        id="queued-jobs"
        class="queue-panel"
        aria-labelledby="queued-jobs-title"
        aria-describedby="queued-jobs-description"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // A backdrop click targets the dialog, but so can clicks in its padding or scrollbar.
          if (e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
            e.currentTarget.close();
        }}
      >
        <header class="queue-panel-header">
          <div>
            <h2 id="queued-jobs-title">Queued jobs</h2>
            <p id="queued-jobs-description" class="help">
              Jobs waiting for YOLO to apply.
            </p>
          </div>
          <button type="button" class="btn" aria-label="Close queued jobs" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </header>
        <div class="queue-panel-filters">
          <input
            ref={search}
            type="search"
            aria-label="Search queued jobs"
            placeholder="Search by job, company, or source"
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
            autoFocus
          />
          <p class="help" role="status">
            {nq
              ? `Showing ${rows.length} of ${queue.length} queued jobs`
              : `${queue.length} job${queue.length === 1 ? "" : "s"} waiting`}
          </p>
          {error && (
            <p role="alert" class="err">
              {error}
            </p>
          )}
        </div>
        <div class="queue-panel-body">
          {open &&
            (queue.length === 0 ? (
              <p class="muted">No queued jobs. Jobs will appear here when YOLO finds new matches.</p>
            ) : rows.length === 0 ? (
              <p class="muted">No queued jobs match your search.</p>
            ) : (
              <ul class="queued-jobs">
                {rows.map((i) => (
                  <li key={i.key}>
                    <div class="queued-job-info">
                      <a href={i.url} target="_blank" rel="noreferrer">
                        {i.company} – {i.title || "(untitled)"}
                      </a>
                      <div class="muted">{[i.source, i.location].filter(Boolean).join(" · ")}</div>
                    </div>
                    <button
                      type="button"
                      class="btn small danger"
                      disabled={busy}
                      title="Drop this job for now; YOLO can queue it again when it next checks"
                      aria-label={`Remove ${i.company} – ${i.title} from the queue`}
                      onClick={() => void remove(i.key)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
        <footer class="queue-panel-footer">
          <p class="help">Removed jobs may be queued again the next time YOLO checks.</p>
          <button
            type="button"
            class="btn danger"
            disabled={busy || queue.length === 0}
            title="Drop every queued job, including jobs hidden by search"
            onClick={() => void remove()}
          >
            Clear queue
          </button>
        </footer>
      </dialog>
    </>
  );
}
