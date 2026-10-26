import { useState } from "preact/hooks";
import { send } from "../../shared/messages";
import { normalize } from "../../shared/normalize";
import { formatDateTime } from "../../shared/time";
import type { Application } from "../../shared/yolo";
import { store, useStored } from "../store";

const STATUS: Record<Application["status"], string> = {
  submitted: "Submitted",
  needs: "Needs you",
  failed: "Failed",
  skipped: "Skipped",
};

export function Applications() {
  const apps = useStored("applications");
  const queue = useStored("yoloQueue");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  if (!apps || !queue) return <p>Loading…</p>;
  const nq = normalize(q);
  const rows = [...apps]
    .reverse()
    .filter(
      (a) =>
        (!status || a.status === status) &&
        (!nq || normalize(`${a.company} ${a.title} ${a.reason} ${a.source}`).includes(nq)),
    );
  const today = apps.filter((a) => a.status === "submitted" && a.at >= new Date().setHours(0, 0, 0, 0)).length;
  return (
    <section>
      <h1>Applications</h1>
      <p class="intro">
        Every application YOLO made, and the ones you submitted yourself after a fill: none of these is applied to
        again. {today} submitted today.
      </p>
      <div class="row-actions">
        <input
          type="search"
          class="search"
          placeholder="Search applications"
          aria-label="Search applications"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />{" "}
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">All</option>
          {Object.entries(STATUS).map(([v, t]) => (
            <option value={v}>{t}</option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <p class="muted">{apps.length ? "No matches." : "Nothing yet."}</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Job</th>
              <th>Status</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr>
                <td class="muted">{formatDateTime(a.at)}</td>
                <td>
                  <a href={a.doneUrl || a.url} target="_blank" rel="noreferrer">
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
                </td>
                <td>
                  {STATUS[a.status]}
                  {a.mode === "manual" ? " (by you)" : ""}
                  {a.reason && <div class="muted">{a.reason}</div>}
                </td>
                <td class="muted">{a.source}</td>
                <td>
                  {(a.status === "needs" || a.status === "failed") && (
                    <button
                      type="button"
                      class="btn small"
                      title="Opens it in a tab and continues there"
                      onClick={() => void send({ type: "YOLO_RESUME", key: a.key })}
                    >
                      Resume
                    </button>
                  )}{" "}
                  <button
                    type="button"
                    class="btn small danger"
                    title="Remove from the log, so YOLO may apply to it again"
                    onClick={() => void send({ type: "YOLO_FORGET", key: a.key })}
                  >
                    Forget
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {queue.length > 0 && (
        <>
          <h2>
            Queued ({queue.length}){" "}
            <button
              type="button"
              class="btn small danger"
              title="Drop every queued job for now; YOLO can queue them again when it next checks"
              onClick={async () => {
                const [q, seen] = await Promise.all([store.get("yoloQueue"), store.get("yoloSeen")]);
                // Unmark them so a later check can queue them again: clearing isn't rejecting.
                for (const i of q) {
                  delete seen[i.key];
                  delete seen[i.alt];
                }
                await store.set({ yoloQueue: [], yoloSeen: seen });
              }}
            >
              Clear queue
            </button>
          </h2>
          <ul>
            {queue.map((i) => (
              <li>
                <a href={i.url} target="_blank" rel="noreferrer">
                  {i.company} – {i.title}
                </a>{" "}
                <span class="muted">{i.source}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
