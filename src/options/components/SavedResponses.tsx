// Applications: an application's saved answers and the résumé and cover letter it went with (background savedStore).
import { useEffect, useState } from "preact/hooks";
import type { SavedApplication } from "../../shared/storage";
import { store } from "../store";

/** Saves a PDF a saved application kept. */
function download(f: { name: string; base64: string }) {
  const data = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  Object.assign(document.createElement("a"), { href: url, download: f.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** Read only once opened: the PDFs can be large. `size` changes when the record does, so it's read again. */
export function SavedResponses({ appKey, size }: { appKey: string; size: number }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedApplication | null | undefined>();
  useEffect(() => {
    if (open) void store.getSaved(appKey).then(setSaved);
  }, [open, appKey, size]);
  return (
    <details class="saved-responses" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary class="muted">Saved responses and documents ({formatBytes(size)})</summary>
      {saved === undefined ? (
        <p class="muted">Loading…</p>
      ) : !saved ? (
        <p class="muted">Nothing saved.</p>
      ) : (
        <>
          <p class="muted">
            Résumé: {saved.resume.join(", ") || "None"} · Cover letter: {saved.letter.join(", ") || "None"}
          </p>
          {saved.files.length > 0 && (
            <div class="row">
              {saved.files.map((f) => (
                <button type="button" class="btn small" onClick={() => download(f)}>
                  Download {f.name}
                </button>
              ))}
            </div>
          )}
          {saved.answers.length ? (
            <ul>
              {saved.answers.map((g) => (
                <li>
                  {g.q}: <b>{g.a}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">No answers saved.</p>
          )}
        </>
      )}
    </details>
  );
}
