import { useEffect, useState } from "preact/hooks";
import { isErr, send } from "../../shared/messages";
import { normalize } from "../../shared/normalize";
import { formatDateTime } from "../../shared/time";
import { isPendingApplication, type Application } from "../../shared/yolo";
import { useStored } from "../store";
import { QueuedJobs } from "../components/QueuedJobs";
import { SourceCheck } from "../components/SourceCheck";
import { ApplicationSummary } from "../components/ApplicationSummary";

const STATUS: Record<Application["status"], string> = {
  submitted: "Submitted",
  needs: "Needs you",
  failed: "Failed",
  skipped: "Skipped",
  review: "Ready for your review",
};

/** Saves a file a debug log kept: the PDF uploaded, or text in older logs. */
function download(f: { name: string; base64?: string; text?: string }) {
  const data = f.base64 ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : (f.text ?? "");
  const url = URL.createObjectURL(new Blob([data], { type: f.base64 ? "application/pdf" : "text/plain" }));
  Object.assign(document.createElement("a"), { href: url, download: f.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Applications() {
  const apps = useStored("applications");
  const queue = useStored("yoloQueue");
  const settings = useStored("settings");
  const logs = useStored("yoloLogs");
  const yoloState = useStored("yoloState");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [reviewTabs, setReviewTabs] = useState<{ live: string[]; refilling: string[] }>({ live: [], refilling: [] });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [forgetting, setForgetting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const failedCount = apps?.filter((a) => a.status === "failed").length ?? 0;
  const pendingCount = apps?.filter(isPendingApplication).length ?? 0;
  const resumePending = async () => {
    if (resuming || !pendingCount) return;
    setResuming(true);
    setMessage("");
    try {
      const r = await send({ type: "YOLO_RESUME_PENDING" });
      if (isErr(r)) setMessage(r.error.message);
      else
        setMessage(
          r.queued
            ? `Queued ${r.queued} pending application${r.queued === 1 ? "" : "s"} to resume one at a time. Existing filled review tabs are kept.`
            : "Pending applications are already queued, running, or ready for your review.",
        );
      loadReviews();
    } catch {
      setMessage("Couldn't reach AutoApply. Please try again.");
    } finally {
      setResuming(false);
    }
  };
  const forgetFailed = async () => {
    if (
      forgetting ||
      !failedCount ||
      !window.confirm(
        "Forget all failed applications? This removes every failed application from your history, including those hidden by filters. YOLO can queue these jobs again the next time it checks. This cannot be undone.",
      )
    )
      return;
    setForgetting(true);
    setMessage("");
    try {
      const r = await send({ type: "YOLO_FORGET_FAILED" });
      if (isErr(r)) setMessage(r.error.message);
      else
        setMessage(
          `Forgot ${r.forgotten} failed application${r.forgotten === 1 ? "" : "s"}. YOLO can queue these jobs again the next time it checks.`,
        );
    } catch {
      setMessage("Couldn't reach AutoApply. Please try again.");
    } finally {
      setForgetting(false);
    }
  };
  const loadReviews = () =>
    void send({ type: "YOLO_REVIEW_LIST" })
      .then(setReviewTabs)
      .catch(() => undefined);
  useEffect(() => {
    if (!apps?.some((a) => a.review || isPendingApplication(a))) return;
    loadReviews();
    window.addEventListener("focus", loadReviews);
    return () => window.removeEventListener("focus", loadReviews);
  }, [apps, yoloState?.reviewUpdatedAt]);
  const applicationAction = async (
    type: "YOLO_REVIEW_OPEN" | "YOLO_REVIEW_REFILL" | "YOLO_REVIEW_DISMISS" | "YOLO_MARK_SUBMITTED",
    key: string,
  ) => {
    setBusy(key);
    setMessage("");
    try {
      const r = await send({ type, key });
      if (isErr(r)) setMessage(r.error.message);
      else if (type === "YOLO_REVIEW_REFILL")
        setMessage(
          "Refill requested. It will start after the current application finishes and will stop before submission.",
        );
      else if (type === "YOLO_MARK_SUBMITTED") setMessage("Application marked as submitted.");
      loadReviews();
    } catch {
      setMessage("Couldn't reach AutoApply. Please try again.");
    } finally {
      setBusy("");
    }
  };
  if (!apps || !queue || !settings || !logs) return <p>Loading…</p>;
  const nq = normalize(q);
  const rows = [...apps]
    .reverse()
    .filter(
      (a) =>
        (!status || a.status === status) &&
        (!nq || normalize(`${a.company} ${a.title} ${a.reason} ${a.source}`).includes(nq)),
    );
  const pending = apps.filter((a) => a.review && ["review", "needs", "failed"].includes(a.status)).length;
  return (
    <section>
      <div class="applications-heading">
        <h1>Applications</h1>
        <QueuedJobs queue={queue} />
      </div>
      <p class="intro">
        Every application YOLO made, and the ones you submitted yourself after a fill: none of these are applied to
        again.
      </p>
      <ApplicationSummary applications={apps} batchAt={yoloState?.batchAt ?? 0} />
      {pending > 0 && (
        <p class="review-summary">
          {pending} application{pending === 1 ? " is" : "s are"} waiting for your review. Open the filled tab, check
          your answers, and submit using the site's button.{" "}
          <button class="btn small" onClick={() => setStatus("review")}>
            Show ready applications
          </button>
        </p>
      )}
      {message && (
        <p role="status" class="help">
          {message}
        </p>
      )}
      <SourceCheck />
      <div class="row">
        <input
          type="search"
          class="search"
          placeholder="Search applications"
          aria-label="Search applications"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">All</option>
          {Object.entries(STATUS).map(([v, t]) => (
            <option value={v}>{t}</option>
          ))}
        </select>
        <button
          type="button"
          class="btn small"
          disabled={!settings.debugLogging}
          title={
            settings.debugLogging
              ? `What YOLO filled in and saw on its last ${settings.debugLogLimit} applications`
              : "Turn on Debug logging in Behavior first"
          }
          aria-expanded={showLogs && settings.debugLogging}
          onClick={() => setShowLogs(!showLogs)}
        >
          Debug logs
        </button>
        <button
          type="button"
          class="btn small primary"
          disabled={resuming || pendingCount === 0}
          title="Resume all Needs you and Ready for your review applications, including those hidden by filters, one at a time"
          onClick={() => void resumePending()}
        >
          {resuming ? "Queueing resumes…" : "Resume all pending applications"}
        </button>
        <button
          type="button"
          class="btn small danger"
          disabled={forgetting || failedCount === 0}
          title="Remove every failed application from the history, including those hidden by filters, so YOLO can queue them again"
          onClick={() => void forgetFailed()}
        >
          {forgetting ? "Forgetting…" : "Forget all failed applications"}
        </button>
      </div>
      {showLogs &&
        settings.debugLogging &&
        (logs.length ? (
          <div class="logs">
            {[...logs].reverse().map((l) => (
              <>
                <pre class="mono">
                  {formatDateTime(l.at)} {l.text}
                </pre>
                {l.files?.map((f) => (
                  <details class="log-file">
                    <summary>
                      {f.name}{" "}
                      <button
                        type="button"
                        class="btn small"
                        onClick={(e) => {
                          e.preventDefault(); // not the details' toggle
                          download(f);
                        }}
                      >
                        Download
                      </button>
                    </summary>
                    {f.text && <pre class="mono">{f.text}</pre>}
                  </details>
                ))}
              </>
            ))}
          </div>
        ) : (
          <p class="muted">No logs yet: they're kept for YOLO applications made while Debug logging is on.</p>
        ))}
      {rows.length === 0 ? (
        <p class="muted">{apps.length ? "No matches." : "Nothing yet."}</p>
      ) : (
        <div class="applications-table-scroll" role="region" aria-label="Application history" tabIndex={0}>
          <table class="table applications-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Job</th>
                <th>Status</th>
                <th>Source</th>
                <th scope="col" class="application-actions-cell">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr>
                  <td class="muted">{formatDateTime(a.at)}</td>
                  <td>
                    <a
                      href={a.doneUrl || a.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => {
                        if (a.review && ["review", "needs", "failed"].includes(a.status)) {
                          e.preventDefault();
                          void applicationAction("YOLO_REVIEW_OPEN", a.key);
                        }
                      }}
                    >
                      {a.company} – {a.title || "(untitled)"}
                    </a>
                    {a.guesses.length > 0 && (
                      <details>
                        <summary class="muted">{a.guesses.length} guessed answers</summary>
                        <ul>
                          {a.guesses.map((g) => (
                            <li>
                              {g.q}: <b>{g.a}</b>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {a.notes?.map((n) => (
                      <div class="muted">{n}</div>
                    ))}
                    {a.review && <div class="muted">Review rules: {a.review.reasons.join("; ")}</div>}
                  </td>
                  <td>
                    {STATUS[a.status]}
                    {a.mode === "manual" || a.submittedBy === "user" ? " (by you)" : ""}
                    {a.reason && <div class="muted">{a.reason}</div>}
                  </td>
                  <td class="muted">{a.source}</td>
                  <td class="application-actions-cell">
                    <div
                      class="application-actions"
                      role="group"
                      aria-label={`Actions for ${a.company} – ${a.title || "(untitled)"}`}
                    >
                      {a.review && ["review", "needs", "failed"].includes(a.status) ? (
                        <div class="review-actions">
                          <button
                            type="button"
                            class="btn small primary"
                            disabled={busy === a.key || reviewTabs.refilling.includes(a.key)}
                            onClick={() =>
                              void applicationAction(
                                reviewTabs.live.includes(a.key) ? "YOLO_REVIEW_OPEN" : "YOLO_REVIEW_REFILL",
                                a.key,
                              )
                            }
                          >
                            {reviewTabs.refilling.includes(a.key)
                              ? "Refill pending…"
                              : reviewTabs.live.includes(a.key)
                                ? "Review application"
                                : "Refill for review"}
                          </button>
                          {!reviewTabs.live.includes(a.key) && (
                            <span class="help">
                              The original filled page is unavailable. Refilling may lose earlier edits.
                            </span>
                          )}
                          <details>
                            <summary class="muted">More actions</summary>
                            <button
                              type="button"
                              class="btn small danger"
                              disabled={busy === a.key || reviewTabs.refilling.includes(a.key)}
                              onClick={() => void applicationAction("YOLO_REVIEW_DISMISS", a.key)}
                            >
                              Dismiss &amp; close tab
                            </button>
                          </details>
                        </div>
                      ) : (
                        (a.status === "needs" || a.status === "failed") && (
                          <button
                            type="button"
                            class="btn small primary"
                            disabled={reviewTabs.refilling.includes(a.key)}
                            title="Opens it in a tab and continues there"
                            onClick={() => void send({ type: "YOLO_RESUME", key: a.key })}
                          >
                            {reviewTabs.refilling.includes(a.key) ? "Resume pending…" : "Resume"}
                          </button>
                        )
                      )}
                      {a.status !== "submitted" && (
                        <button
                          type="button"
                          class="btn small"
                          disabled={busy === a.key}
                          title="Record that you already submitted this application on the job site"
                          onClick={() => void applicationAction("YOLO_MARK_SUBMITTED", a.key)}
                        >
                          Mark submitted
                        </button>
                      )}
                      {!(a.review && ["review", "needs", "failed"].includes(a.status)) && (
                        <button
                          type="button"
                          class="btn small danger"
                          title="Remove from the log, so YOLO may apply to it again"
                          onClick={() => void send({ type: "YOLO_FORGET", key: a.key })}
                        >
                          Forget
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
