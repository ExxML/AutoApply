import { useRef, useState } from "preact/hooks";
import {
  applyImportPlan,
  buildImportPlan,
  CARRIED,
  ExportSchema,
  readImportSnapshot,
  type Export,
  type ImportPlan,
} from "../importData";
import { send } from "../../shared/messages";
import { ImportPreview } from "../components/ImportPreview";
import { markSaved, store } from "../store";

export function Data() {
  const [withKeys, setWithKeys] = useState(true);
  const [withDocs, setWithDocs] = useState(true);
  const [pending, setPending] = useState<{ plan: ImportPlan; fileName: string } | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const readVersion = useRef(0);
  const applying = useRef(false);
  const [msg, setMsg] = useState("");
  const [resetStep, setResetStep] = useState(0);

  const doExport = async () => {
    const {
      profile,
      settings,
      documentsIndex,
      apiKeys,
      selectedModel,
      fallbackModel,
      reviewModel,
      yolo,
      applications,
    } = await store.getMany([
      "profile",
      "settings",
      "documentsIndex",
      "apiKeys",
      "selectedModel",
      "fallbackModel",
      "reviewModel",
      "yolo",
      "applications",
    ]);
    const documents = [];
    if (withDocs)
      for (const meta of documentsIndex) documents.push({ meta, base64: (await store.getDoc(meta.id)) ?? "" });
    const info = withDocs ? await store.get("tailorResume") : null;
    const tailorResume = info && {
      info,
      tex: (await store.getDoc("tailor-tex")) ?? "",
      pdf: (await store.getDoc("tailor-pdf")) ?? "",
      fallbackPdf: (await store.getDoc("tailor-fallback-pdf")) ?? undefined,
    };
    const local: Record<string, unknown> = await store.getMany([
      ...CARRIED,
      ...(withKeys ? ["keyState" as const] : []),
    ]);
    const { batchAt, queueOnlyBatch } = await store.get("yoloState");
    local.yoloState = { batchAt, queueOnlyBatch };
    const data: Export = {
      app: "autoapply",
      version: 1,
      profile,
      settings,
      selectedModel,
      fallbackModel,
      reviewModel,
      yolo,
      applications,
      local,
      ...(withDocs ? { documents, tailorResume } : {}),
      ...(withKeys ? { apiKeys } : {}),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "autoapply-export.json" });
    a.click();
    URL.revokeObjectURL(url);
  };

  const readImport = async (file: File) => {
    const version = ++readVersion.current;
    setMsg("");
    setError("");
    setPending(null);
    setReading(true);
    try {
      const r = ExportSchema.safeParse(JSON.parse(await file.text()));
      if (version !== readVersion.current) return;
      if (!r.success) return setError("That file is not an AutoApply export.");
      const plan = buildImportPlan(r.data, await readImportSnapshot(store));
      if (version !== readVersion.current) return;
      setSelected(new Set(plan.changes.map((c) => c.id)));
      setPending({ plan, fileName: file.name });
    } catch {
      if (version === readVersion.current) setError("Could not read that file as an AutoApply JSON export.");
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  };

  const applyImport = async () => {
    if (!pending || applying.current || !selected.size) return;
    applying.current = true;
    setBusy(true);
    setError("");
    try {
      const values = await applyImportPlan(pending.plan, selected, store);
      if (values.keyState || Object.hasOwn(values, "yoloInFlight"))
        await send({
          type: "IMPORTED",
          keyState: values.keyState,
          recoverInFlight: Object.hasOwn(values, "yoloInFlight"),
        }).catch(() => undefined);
      markSaved();
      setPending(null);
      setMsg("Selected changes imported.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import the selected changes. Please try again.");
    } finally {
      applying.current = false;
      setBusy(false);
    }
  };

  const reset = async () => {
    if (resetStep < 2) return setResetStep(resetStep + 1);
    await chrome.storage.local.clear();
    indexedDB.deleteDatabase("autoapply-vault"); // the site passwords' key (background/yolo/vault.ts)
    markSaved();
    setResetStep(0);
    setMsg("Everything was reset.");
  };

  return (
    <section>
      <h1>Data</h1>
      <div class="panel-box">
        <h2>Export</h2>
        <p>Profile, settings, models, site rules, documents and YOLO's applications and queue as one JSON file.</p>
        <label class="inline">
          <input type="checkbox" checked={withKeys} onChange={(e) => setWithKeys(e.currentTarget.checked)} /> Include
          API keys
        </label>
        <label class="inline">
          <input type="checkbox" checked={withDocs} onChange={(e) => setWithDocs(e.currentTarget.checked)} /> Include
          documents
        </label>
        <div class="row">
          <button type="button" class="btn" onClick={() => void doExport()}>
            Export JSON
          </button>
        </div>
      </div>
      <div class="panel-box">
        <h2>Import</h2>
        <p>Choose an AutoApply JSON export to review its changes before importing.</p>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Import JSON file"
          disabled={busy}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void readImport(f);
            e.currentTarget.value = "";
          }}
        />
        {reading && <p role="status">Preparing import preview…</p>}
        {pending && (
          <ImportPreview
            key={readVersion.current}
            plan={pending.plan}
            fileName={pending.fileName}
            selected={selected}
            busy={busy}
            error={error}
            onSelect={(choices) => {
              setSelected(choices);
              setError("");
            }}
            onImport={() => void applyImport()}
            onCancel={() => {
              setPending(null);
              setError("");
            }}
          />
        )}
        {error && !pending && (
          <p class="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div class="panel-box danger-zone">
        <h2>Reset everything</h2>
        <p>Deletes your profile, documents, saved answers, keys and settings from this browser.</p>
        <button type="button" class="btn danger" disabled={busy} onClick={() => void reset()}>
          {["Reset everything", "Are you sure? Click again", "This cannot be undone — click to reset"][resetStep]}
        </button>
        {resetStep > 0 && (
          <button type="button" class="btn" onClick={() => setResetStep(0)}>
            Cancel
          </button>
        )}
      </div>
      {msg && (
        <p class="ok" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
