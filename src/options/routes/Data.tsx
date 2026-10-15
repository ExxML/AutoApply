import { useState } from "preact/hooks";
import { z } from "zod";
import { ProfileSchema } from "../../shared/profileSchema";
import { SettingsSchema } from "../../shared/settings";
import { ApiKeyEntrySchema, DocumentMetaSchema } from "../../shared/storage";
import { markSaved, save, store } from "../store";

const ExportSchema = z.object({
  app: z.literal("autoapply"),
  version: z.literal(1),
  profile: z.unknown(),
  settings: z.unknown(),
  documents: z.array(z.object({ meta: DocumentMetaSchema, base64: z.string() })).optional(),
  apiKeys: z.array(ApiKeyEntrySchema).optional(),
  selectedModel: z.string().nullable(),
  fallbackModel: z.string().nullable(),
});
type Export = z.infer<typeof ExportSchema>;

export function Data() {
  const [withKeys, setWithKeys] = useState(false);
  const [withDocs, setWithDocs] = useState(true);
  const [pending, setPending] = useState<{ data: Export; summary: string[] } | null>(null);
  const [msg, setMsg] = useState("");
  const [resetStep, setResetStep] = useState(0);

  const doExport = async () => {
    const { profile, settings, documentsIndex, apiKeys, selectedModel, fallbackModel } = await store.getMany([
      "profile",
      "settings",
      "documentsIndex",
      "apiKeys",
      "selectedModel",
      "fallbackModel",
    ]);
    const documents = [];
    if (withDocs)
      for (const meta of documentsIndex) documents.push({ meta, base64: (await store.getDoc(meta.id)) ?? "" });
    const data: Export = {
      app: "autoapply",
      version: 1,
      profile,
      settings,
      selectedModel,
      fallbackModel,
      ...(withDocs ? { documents } : {}),
      ...(withKeys ? { apiKeys } : {}),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "autoapply-export.json" });
    a.click();
    URL.revokeObjectURL(url);
  };

  const readImport = async (file: File) => {
    setMsg("");
    try {
      const r = ExportSchema.safeParse(JSON.parse(await file.text()));
      if (!r.success) return setMsg("That file is not an AutoApply export.");
      const cur = await store.getMany(["profile", "settings", "documentsIndex", "apiKeys"]);
      const incoming = ProfileSchema.parse(r.data.profile);
      const summary = [
        `Profile: ${incoming.personal.firstName || "(no name)"} ${incoming.personal.lastName} replaces ${cur.profile.personal.firstName || "(empty profile)"} ${cur.profile.personal.lastName}`,
        `Saved answers: ${cur.profile.learnedAnswers.length} → ${incoming.learnedAnswers.length}`,
        r.data.documents
          ? `Documents: ${cur.documentsIndex.length} → ${r.data.documents.length}`
          : "Documents: unchanged",
        "Settings: replaced",
        "Models: replaced",
        r.data.apiKeys ? `API keys: ${cur.apiKeys.length} → ${r.data.apiKeys.length}` : "API keys: unchanged",
      ];
      setPending({ data: r.data, summary });
    } catch {
      setMsg("Could not read that file as JSON.");
    }
  };

  const applyImport = async () => {
    if (!pending) return;
    const { data } = pending;
    if (data.documents) {
      const old = await store.get("documentsIndex");
      for (const d of old) await store.removeDoc(d.id);
      for (const d of data.documents) await store.setDoc(d.meta.id, d.base64);
    }
    await store.setProfile(ProfileSchema.parse(data.profile));
    await save({
      settings: SettingsSchema.parse(data.settings),
      ...(data.documents ? { documentsIndex: data.documents.map((d) => d.meta) } : {}),
      ...(data.apiKeys ? { apiKeys: data.apiKeys } : {}),
      selectedModel: data.selectedModel,
      fallbackModel: data.fallbackModel,
    });
    setPending(null);
    setMsg("Imported.");
  };

  const reset = async () => {
    if (resetStep < 2) return setResetStep(resetStep + 1);
    await chrome.storage.local.clear();
    markSaved();
    setResetStep(0);
    setMsg("Everything was reset.");
  };

  return (
    <section>
      <h1>Data</h1>
      <div class="panel-box">
        <h2>Export</h2>
        <p>Profile, settings, models, site rules and documents as one JSON file.</p>
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
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Import JSON file"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void readImport(f);
            e.currentTarget.value = "";
          }}
        />
        {pending && (
          <div class="confirm">
            <p>This import will change:</p>
            <ul>
              {pending.summary.map((s) => (
                <li>{s}</li>
              ))}
            </ul>
            <div class="row">
              <button type="button" class="btn primary" onClick={() => void applyImport()}>
                Import
              </button>
              <button type="button" class="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div class="panel-box">
        <h2>Decision cache</h2>
        <p>Remembered AI answers that skip repeat calls. Clearing it is safe.</p>
        <button
          type="button"
          class="btn"
          onClick={() => void save({ decisionCache: {} }).then(() => setMsg("Decision cache cleared."))}
        >
          Clear decision cache
        </button>
      </div>
      <div class="panel-box danger-zone">
        <h2>Reset everything</h2>
        <p>Deletes your profile, documents, saved answers, keys and settings from this browser.</p>
        <button type="button" class="btn danger" onClick={() => void reset()}>
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
