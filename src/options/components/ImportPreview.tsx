import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { importEntryLabel, importLabel, importSelection, type ImportChange, type ImportPlan } from "../importData";

function Selection({
  label,
  ids,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  ids: string[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onChange: (ids: string[], checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const count = ids.filter((id) => selected.has(id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < ids.length;
  }, [count, ids.length]);
  return (
    <label class="import-select">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={count === ids.length}
        disabled={disabled}
        onChange={(e) => onChange(ids, e.currentTarget.checked)}
      />
      <span>{label}</span>
      <span class="muted">
        {count} / {ids.length}
      </span>
    </label>
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const empty = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
export const importAction = (c: ImportChange): string =>
  c.kind === "order" ? "Reorder" : empty(c.after) ? "Remove" : empty(c.before) ? "Add" : "Replace";

function download(base64: string, fileName: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sourceText(base64: unknown): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(String(base64)), (c) => c.charCodeAt(0)));
  } catch {
    return "Could not decode the LaTeX source in this file.";
  }
}

/** Values are rendered as text, including imported prompts and HTML; imported content is never executed. */
function Value({ value, kind, revealed }: { value: unknown; kind: ImportChange["kind"]; revealed: boolean }) {
  const [error, setError] = useState("");
  if (empty(value)) return <span class="muted">{Array.isArray(value) ? "Empty list" : "Not set"}</span>;
  if (kind === "document" && isRecord(value) && isRecord(value.meta))
    return (
      <>
        <Value value={value.meta} kind="value" revealed={revealed} />
        <button
          class="btn small"
          type="button"
          onClick={() => {
            try {
              download(String(value.base64), String((value.meta as Record<string, unknown>).fileName));
            } catch {
              setError("This file’s contents could not be downloaded.");
            }
          }}
        >
          Download file to inspect
        </button>
        {error && (
          <p class="err" role="alert">
            {error}
          </p>
        )}
      </>
    );
  if (kind === "tailor" && isRecord(value)) {
    const info = isRecord(value.info) ? value.info : {};
    return (
      <>
        <Value value={info} kind="value" revealed={revealed} />
        <details>
          <summary>LaTeX source</summary>
          <pre class="import-text">{sourceText(value.tex)}</pre>
        </details>
        <button
          class="btn small"
          type="button"
          onClick={() => {
            try {
              download(String(value.tex), String(info.fileName ?? "resume.tex"));
            } catch {
              setError("This file’s contents could not be downloaded.");
            }
          }}
        >
          Download LaTeX source
        </button>
        {(
          [
            ["pdf", "Untailored PDF", "resume.pdf"],
            ["fallbackPdf", "Fallback PDF", "fallback.pdf"],
          ] as const
        ).map(([key, label, name]) =>
          value[key] ? (
            <button
              key={key}
              class="btn small"
              type="button"
              onClick={() => {
                try {
                  download(String(value[key]), name);
                } catch {
                  setError("This file’s contents could not be downloaded.");
                }
              }}
            >
              Download {label}
            </button>
          ) : null,
        )}
        {error && (
          <p class="err" role="alert">
            {error}
          </p>
        )}
      </>
    );
  }
  if (Array.isArray(value))
    return (
      <ol class="import-list">
        {value.map((item, i) => (
          <li key={i}>
            <Value value={item} kind="value" revealed={revealed} />
          </li>
        ))}
      </ol>
    );
  if (isRecord(value))
    return (
      <dl class="import-object">
        {Object.entries(value).map(([key, v]) => (
          <div key={key}>
            <dt>{importLabel(key)}</dt>
            <dd>
              {key === "key" && !revealed ? (
                <span>••••{String(v).slice(-4)}</span>
              ) : (
                <Value value={v} kind="value" revealed={revealed} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span class="import-text">{typeof value === "boolean" ? (value ? "On" : "Off") : String(value)}</span>;
}

function Change({
  change,
  selected,
  locked,
  disabled,
  onChange,
}: {
  change: ImportChange;
  selected: boolean;
  locked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const secret = change.key === "apiKeys" || change.path.includes("gmailClientSecret");
  const action = importAction(change);
  return (
    <article class={`import-change${selected ? " selected" : ""}`}>
      <div class="import-change-heading">
        <label class="import-select">
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled || locked}
            aria-label={`${action} ${change.label}`}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
          <span>{change.label}</span>
        </label>
        <span class={`import-action ${action.toLowerCase()}`}>{action}</span>
      </div>
      {locked && <p class="help">Required when importing YOLO preferences. YOLO stays off until you turn it on.</p>}
      {secret && (
        <button class="btn small" type="button" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
          {revealed ? "Hide sensitive values" : "Show sensitive values"}
        </button>
      )}
      <div class="import-comparison">
        <div>
          <h4>Current</h4>
          {secret && change.key !== "apiKeys" && !revealed ? (
            <span>{empty(change.before) ? "Not set" : "••••••••"}</span>
          ) : (
            <Value value={change.before} kind={change.kind} revealed={change.key !== "apiKeys" || revealed} />
          )}
        </div>
        <div>
          <h4>From file</h4>
          {secret && change.key !== "apiKeys" && !revealed ? (
            <span>{empty(change.after) ? "Not set" : "••••••••"}</span>
          ) : (
            <Value value={change.after} kind={change.kind} revealed={change.key !== "apiKeys" || revealed} />
          )}
        </div>
      </div>
    </article>
  );
}

const PAGE_ORDER = ["Profile", "Documents", "Saved Answers", "AI", "Behavior", "YOLO Mode", "Applications", "Data"];

export function ImportPreview({
  plan,
  fileName,
  selected,
  busy,
  error,
  onSelect,
  onImport,
  onCancel,
}: {
  plan: ImportPlan;
  fileName: string;
  selected: ReadonlySet<string>;
  busy: boolean;
  error: string;
  onSelect: (selected: Set<string>) => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const choices = importSelection(plan, selected);
  const changes = plan.changes;
  const counts = changes.reduce<Record<string, number>>((out, c) => {
    const action = importAction(c);
    out[action] = (out[action] ?? 0) + 1;
    return out;
  }, {});
  const selectedChanges = changes.filter((c) => choices.has(c.id));
  const count = selectedChanges.length;
  const yoloSelected = selectedChanges.some((c) => c.key === "yolo" && c.path[0] !== "enabled");
  // Do not index secret or binary values for search. Searching never discloses a masked credential.
  const searchIndex = useMemo(
    () =>
      new Map(
        changes.map((c) => [
          c.id,
          `${c.page} ${c.section} ${c.label} ${
            c.kind === "document"
              ? importEntryLabel(c.after ?? c.before)
              : c.kind === "tailor" || c.key === "apiKeys" || c.path.includes("gmailClientSecret")
                ? ""
                : JSON.stringify([c.before, c.after])
          }`.toLocaleLowerCase(),
        ]),
      ),
    [changes],
  );
  const visible = changes.filter(
    (c) =>
      (filter === "all" || importAction(c) === filter) &&
      searchIndex.get(c.id)!.includes(query.trim().toLocaleLowerCase()),
  );
  const pages = PAGE_ORDER.map((page) => ({ page, changes: visible.filter((c) => c.page === page) })).filter(
    (p) => p.changes.length,
  );
  const toggle = (ids: string[], checked: boolean) => {
    const next = new Set(selected);
    for (const id of ids)
      if (checked) next.add(id);
      else next.delete(id);
    onSelect(next);
  };
  const expand = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  const allGroups = [...new Set(changes.flatMap((c) => [c.page, `${c.page}/${c.section}`]))];
  return (
    <div class="import-preview" aria-busy={busy}>
      <h3 ref={heading} tabIndex={-1}>
        Review import
      </h3>
      <p class="import-filename">{fileName}</p>
      <p>Choose the changes to import. Unchecked values stay as they are. Identical values are omitted.</p>
      <p class="help">
        List entries can be selected separately. Importing list order follows the file’s order and keeps any retained
        entries after it. Files can be downloaded for inspection.
      </p>
      {changes.some((c) => c.key === "yolo") && (
        <p class="help">Importing YOLO preferences turns YOLO off until you turn it on again.</p>
      )}
      <div class="import-counts" aria-label="Import changes">
        {["Add", "Replace", "Remove", "Reorder"].map((action) => (
          <span key={action}>
            <strong>{counts[action] ?? 0}</strong> {action.toLowerCase()}
          </span>
        ))}
      </div>
      {changes.length > 0 ? (
        <>
          <div class="import-tools">
            <label>
              Search changes
              <input
                type="search"
                value={query}
                placeholder="Page, field or value"
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </label>
            <label>
              Change type
              <select aria-label="Change type" value={filter} onChange={(e) => setFilter(e.currentTarget.value)}>
                <option value="all">All changes</option>
                {["Add", "Replace", "Remove", "Reorder"].map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div class="row import-bulk">
            <button
              type="button"
              class="btn small"
              disabled={busy}
              onClick={() =>
                toggle(
                  changes.map((c) => c.id),
                  true,
                )
              }
            >
              Select all
            </button>
            <button type="button" class="btn small" disabled={busy} onClick={() => onSelect(new Set())}>
              Select none
            </button>
            <button type="button" class="btn small" onClick={() => setExpanded(new Set(allGroups))}>
              Expand all
            </button>
            <button type="button" class="btn small" onClick={() => setExpanded(new Set())}>
              Collapse all
            </button>
          </div>
          <p class="help">
            Showing {visible.length} of {changes.length} changes. Page and subsection checkboxes affect all changes in
            that group, including those hidden by filters.
          </p>
          {!visible.length && <p role="status">No changes match your search or filter.</p>}
          {pages.map(({ page, changes: pageChanges }) => (
            <div class="import-page" key={page}>
              <div class="import-group-heading">
                <Selection
                  label={page}
                  ids={changes.filter((c) => c.page === page).map((c) => c.id)}
                  selected={choices}
                  disabled={busy}
                  onChange={toggle}
                />
                <button
                  type="button"
                  class="btn small"
                  aria-expanded={expanded.has(page)}
                  aria-controls={`import-${PAGE_ORDER.indexOf(page)}`}
                  onClick={() => expand(page, !expanded.has(page))}
                >
                  {expanded.has(page) ? "Collapse" : "Review changes"}
                  <span class="sr-only"> {page}</span>
                </button>
              </div>
              {expanded.has(page) && (
                <div id={`import-${PAGE_ORDER.indexOf(page)}`}>
                  {[...new Set(pageChanges.map((c) => c.section))].map((section) => {
                    const id = `${page}/${section}`;
                    const groupChanges = pageChanges.filter((c) => c.section === section);
                    return (
                      <div class="import-section" key={section}>
                        <div class="import-group-heading">
                          <Selection
                            label={section}
                            ids={changes.filter((c) => c.page === page && c.section === section).map((c) => c.id)}
                            selected={choices}
                            disabled={busy}
                            onChange={toggle}
                          />
                          <button
                            type="button"
                            class="btn small"
                            aria-expanded={expanded.has(id)}
                            aria-controls={`import-group-${allGroups.indexOf(id)}`}
                            onClick={() => expand(id, !expanded.has(id))}
                          >
                            {expanded.has(id) ? "Collapse" : "Review changes"}
                            <span class="sr-only"> {section}</span>
                          </button>
                        </div>
                        {expanded.has(id) && (
                          <div id={`import-group-${allGroups.indexOf(id)}`}>
                            {groupChanges.map((change) => (
                              <Change
                                key={change.id}
                                change={change}
                                selected={choices.has(change.id)}
                                locked={yoloSelected && change.key === "yolo" && change.path[0] === "enabled"}
                                disabled={busy}
                                onChange={(checked) => toggle([change.id], checked)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </>
      ) : (
        <p role="status">This file matches your current data. There is nothing to import.</p>
      )}
      <div class="import-footer">
        {error && (
          <p class="err import-error" role="alert">
            {error}
          </p>
        )}
        <span role="status" aria-live="polite">
          {count} of {changes.length} changes selected
        </span>
        <div class="row">
          <button type="button" class="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" class="btn primary" disabled={busy || !count} onClick={onImport}>
            {busy ? "Importing…" : `Import ${count} selected ${count === 1 ? "change" : "changes"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
