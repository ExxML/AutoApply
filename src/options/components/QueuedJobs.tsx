import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { namesPosting } from "../../background/yolo/jobKey";
import { isErr, send } from "../../shared/messages";
import { normalize } from "../../shared/normalize";
import { SOURCE_NAMES, type AddedPlacement, type QueueItem } from "../../shared/yolo";
import { readPosting } from "../posting";
import { save, store, useStored } from "../store";

export const PLACEMENT_NAMES: [AddedPlacement, string][] = [
  ["front", "At the front of the queue"],
  ["order", "Where Apply order puts them"],
  ["end", "At the end of the queue"],
];
const PLACED: Record<AddedPlacement, string> = {
  front: "to the front of the queue",
  order: "to the queue by your Apply order",
  end: "to the end of the queue",
};

type Job = { url: string; company: string; title: string; postedAt?: number };
type Skipped = { url: string; reason: string };
const isPosting = (url: string) => /^https?:\/\//i.test(url) && namesPosting(url);

/** The links in pasted text, once each. A LinkedIn search's selected job becomes its own posting's link. */
export function pastedLinks(text: string): string[] {
  const links = text.split(/\s+/).map((raw) => {
    const id = /^https?:\/\/([\w-]+\.)?linkedin\.com\/jobs\/.*[?&]currentJobId=(\d+)/i.exec(raw)?.[2];
    return id ? `https://www.linkedin.com/jobs/view/${id}/` : raw;
  });
  return [...new Set(links.filter(Boolean))];
}

/**
 * Queues jobs by their links. Company and title are read from each posting, and asked for only where its page
 * doesn't name them: YOLO needs them to recognise the same job on another site.
 */
function AddJobs(props: { onClose: (added?: string) => void }) {
  const y = useStored("yolo");
  const [text, setText] = useState("");
  // Jobs whose pages don't name their company or title, for the user to complete.
  const [details, setDetails] = useState<Job[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [busy, setBusy] = useState<"" | "reading" | "adding">("");
  const [error, setError] = useState("");
  const [addedText, setAddedText] = useState("");
  const form = useRef<HTMLFormElement>(null);
  // autofocus is ignored on inputs added after load: the first empty field, on opening and when details are asked.
  useLayoutEffect(() => form.current?.querySelector<HTMLElement>(":is(input, textarea):invalid")?.focus(), [details]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || !y) return;
    setError("");
    setAddedText("");
    try {
      let jobs = details;
      let missing: Job[] = [];
      const links = details.length ? [] : pastedLinks(text);
      const bad = links.filter((u) => !isPosting(u)).map((url) => ({ url, reason: "Not a link to one job posting" }));
      if (!details.length) {
        setBusy("reading");
        const read = await Promise.all(
          links.filter(isPosting).map(async (url) => ({ ...(await readPosting(url)), url })),
        );
        jobs = read.filter((j) => j.company && j.title);
        missing = read.filter((j) => !j.company || !j.title);
      }
      setBusy("adding");
      const r = jobs.length
        ? await send({ type: "YOLO_QUEUE_ADD", jobs })
        : { ok: true as const, added: 0, skipped: [] };
      if (isErr(r)) return setError(r.error.message);
      const notAdded = [...bad, ...r.skipped];
      const done = r.added ? `Added ${r.added} job${r.added === 1 ? "" : "s"} ${PLACED[y.addedPlacement]}.` : "";
      setText("");
      setDetails(missing);
      setSkipped(notAdded);
      if (!missing.length && !notAdded.length) return props.onClose(done);
      setAddedText(done);
    } catch {
      setError("Couldn't add them. Try again.");
    } finally {
      setBusy("");
    }
  };
  const edit = (i: number, patch: Partial<Job>) =>
    setDetails(details.map((j, k) => (k === i ? { ...j, ...patch } : j)));

  return (
    <form
      ref={form}
      id="queue-add"
      class="queue-add"
      aria-label="Add jobs to the queue"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        // Closes the form, not the whole panel.
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        props.onClose(addedText);
      }}
    >
      {details.length ? (
        <>
          <p class="help" id="queue-add-details-help">
            {details.length === 1 ? "This page doesn't" : "These pages don't"} name the company and job title. Enter
            them, so YOLO won't apply to the same job twice through another site.
          </p>
          <ul class="queue-add-details">
            {details.map((j, i) => (
              <li key={j.url}>
                <a href={j.url} target="_blank" rel="noreferrer">
                  {j.url}
                </a>
                <div class="row">
                  {(
                    [
                      ["company", "Company"],
                      ["title", "Job title"],
                    ] as const
                  ).map(([k, label]) => (
                    <input
                      required
                      placeholder={label}
                      aria-label={`${label} for ${j.url}`}
                      aria-describedby="queue-add-details-help"
                      value={j[k]}
                      onInput={(e) => edit(i, { [k]: e.currentTarget.value })}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <label for="queue-add-links">Job posting links</label>
          <textarea
            id="queue-add-links"
            required
            rows={3}
            placeholder="Paste one or more links, one per line"
            aria-describedby="queue-add-help"
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <p class="help" id="queue-add-help">
            YOLO applies to these as they are: your searches, title and date filters and the AI fit check are skipped.
          </p>
        </>
      )}
      <div class="row">
        <label class="queue-add-placement">
          Put them
          <select
            value={y?.addedPlacement ?? "front"}
            disabled={!y}
            onChange={(e) =>
              y && void save({ yolo: { ...y, addedPlacement: e.currentTarget.value as AddedPlacement } })
            }
          >
            {PLACEMENT_NAMES.map(([v, t]) => (
              <option value={v}>{t}</option>
            ))}
          </select>
        </label>
        <button type="submit" class="btn small primary" disabled={!!busy || !y}>
          {busy === "reading" ? "Reading postings…" : busy === "adding" ? "Adding…" : "Add"}
        </button>
        <button type="button" class="btn small" onClick={() => props.onClose(addedText)}>
          {details.length ? "Skip these" : "Cancel"}
        </button>
      </div>
      {y && !y.enabled && <p class="help">YOLO is off: queued jobs wait until you turn it on.</p>}
      {addedText && (
        <p role="status" class="ok">
          {addedText}
        </p>
      )}
      {skipped.length > 0 && (
        <div role="alert" class="err">
          Not added:
          <ul class="queue-add-skipped">
            {skipped.map((s) => (
              <li key={s.url}>
                {s.url} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" class="err">
          {error}
        </p>
      )}
    </form>
  );
}

/** Keep the queue off the application history, with native modal focus and Escape handling. */
export function QueuedJobs({ queue }: { queue: QueueItem[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [addedText, setAddedText] = useState("");
  const addToggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const panel = dialog.current!;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    panel.showModal();
    // showModal focuses the search box: an add form opened with the panel takes it instead.
    panel.querySelector<HTMLElement>(".queue-add :invalid")?.focus();
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
          setAddedText("");
          // An empty queue opens on the one thing to do with it.
          setAdding(queue.length === 0);
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
          <div class="queue-panel-actions">
            <button
              type="button"
              class="btn primary"
              ref={addToggle}
              aria-expanded={adding}
              aria-controls="queue-add"
              onClick={() => {
                setAddedText("");
                setAdding(!adding);
              }}
            >
              Add jobs
            </button>
            <button type="button" class="btn" aria-label="Close queued jobs" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </div>
        </header>
        {adding && (
          <AddJobs
            onClose={(added) => {
              setAdding(false);
              setAddedText(added ?? "");
              addToggle.current?.focus();
            }}
          />
        )}
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
          {addedText && (
            <p role="status" class="ok">
              {addedText}
            </p>
          )}
        </div>
        <div class="queue-panel-body">
          {open &&
            (queue.length === 0 ? (
              <p class="muted">
                No queued jobs. Jobs will appear here when YOLO finds new matches, or when you add them.
              </p>
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
                      <div class="muted">
                        {[i.source === "added" ? SOURCE_NAMES.added : i.source, i.location].filter(Boolean).join(" · ")}
                      </div>
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
