import { useEffect, useState } from "preact/hooks";
import type { Application } from "../../shared/yolo";

const startOfToday = () => new Date().setHours(0, 0, 0, 0);
const nextDay = (day: number) => {
  const date = new Date(day);
  date.setDate(date.getDate() + 1);
  return date.getTime();
};

/** `batchAt`: when the current YOLO batch started (0 if none has). */
export function ApplicationSummary({ applications, batchAt }: { applications: Application[]; batchAt: number }) {
  const [day, setDay] = useState(startOfToday);
  useEffect(() => {
    const refresh = () => setDay(startOfToday());
    const timer = window.setTimeout(refresh, Math.max(0, nextDay(day) - Date.now()));
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [day]);

  const today = { submitted: 0, attempted: 0, failed: 0, pending: 0 };
  const batch = { ...today };
  const allTime = { ...today };
  const tomorrow = nextDay(day);
  // Count each recorded job once; skipped postings never became application attempts.
  for (const app of applications) {
    if (app.status === "skipped") continue;
    const outcome = app.status === "submitted" || app.status === "failed" ? app.status : "pending";
    allTime.attempted++;
    allTime[outcome]++;
    if (app.at >= day && app.at < tomorrow) {
      today.attempted++;
      today[outcome]++;
    }
    if (batchAt && app.at >= batchAt) {
      batch.attempted++;
      batch[outcome]++;
    }
  }

  return (
    <dl class="application-summary" aria-label="Application totals">
      {[
        { label: "Batch", counts: batch },
        { label: "Today", counts: today },
        { label: "All time", counts: allTime },
      ].map(({ label, counts }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd class="application-summary-result">
            <strong>{counts.submitted.toLocaleString()}</strong> submitted
            <span class="muted"> / {counts.attempted.toLocaleString()} attempted</span>
          </dd>
          <dd class="application-summary-detail">
            {counts.failed.toLocaleString()} failed
            {counts.pending > 0 && ` · ${counts.pending.toLocaleString()} pending`}
          </dd>
        </div>
      ))}
    </dl>
  );
}
