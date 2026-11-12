import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import { emptyProfile, ExperienceSchema, ProjectSchema } from "../../src/shared/profileSchema";
import { defaultSettings } from "../../src/shared/settings";
import { createStorage, LOCAL_SCHEMAS } from "../../src/shared/storage";
import { ApplicationSchema, defaultYolo, QueueItemSchema } from "../../src/shared/yolo";
import {
  applyImportPlan,
  buildImportPlan,
  ExportSchema,
  importSelection,
  readImportSnapshot,
  type Export,
  type ImportChange,
} from "../../src/options/importData";

let mock: ReturnType<typeof installChromeMock>;
const store = createStorage("options");
const all = (plan: ReturnType<typeof buildImportPlan>) => new Set(plan.changes.map((c) => c.id));
const doc = (id: string, primary = false) => ({
  meta: {
    id,
    label: id,
    kind: "resume" as const,
    fileName: `${id}.pdf`,
    mimeType: "application/pdf",
    size: 4,
    isPrimaryResume: primary,
    uploadedAt: 1,
  },
  base64: btoa(id),
});
const data = (patch: Partial<Export> = {}): Export => ({
  app: "autoapply",
  version: 1,
  profile: emptyProfile(),
  settings: defaultSettings(),
  selectedModel: null,
  fallbackModel: null,
  ...patch,
});
async function planFor(incoming: Export) {
  return buildImportPlan(incoming, await readImportSnapshot(store));
}
const pick = (plan: ReturnType<typeof buildImportPlan>, fn: (c: ImportChange) => boolean) =>
  new Set(plan.changes.filter(fn).map((c) => c.id));

beforeEach(() => {
  vi.restoreAllMocks();
  mock = installChromeMock();
});

describe("selective import planning", () => {
  it("omits identical data and optional sections absent from older exports", async () => {
    const original = doc("old");
    await store.set({
      documentsIndex: [original.meta],
      apiKeys: [{ id: "key", key: "secret", label: "Keep", addedAt: 1 }],
      reviewModel: "keep",
      yolo: { ...defaultYolo(), batchSize: 12 },
    });
    await store.setDoc("old", original.base64);
    const plan = await planFor(data());
    expect(plan.changes).toEqual([]);
    const spy = vi.spyOn(store, "set");
    await applyImportPlan(plan, all(plan), store);
    expect(spy).not.toHaveBeenCalled();
    expect(await store.getDoc("old")).toBe(original.base64);
  });

  it("groups every profile field and settings page, including nested YOLO review settings", async () => {
    const profile = emptyProfile();
    profile.personal.firstName = "Ada";
    profile.preferences.desiredCompensation.amount = "30";
    profile.highSchool.name = "School";
    profile.resumeText = "Résumé facts";
    const settings = {
      ...defaultSettings(),
      essayDefaultWords: 200,
      tailorPrompt: "My prompt",
      overwritePrefilled: true,
      claude: { ...defaultSettings().claude, fill: { model: "sonnet", effort: "low" as const } },
    };
    const yolo = {
      ...defaultYolo(),
      batchSize: 9,
      submissionReview: { ...defaultYolo().submissionReview, mode: "all" as const },
    };
    const plan = await planFor(data({ profile, settings, yolo }));
    expect(plan.changes.map((c) => [c.page, c.section, c.label])).toEqual(
      expect.arrayContaining([
        ["Profile", "Personal", "First name"],
        ["Profile", "Preferences", "Lowest pay"],
        ["Profile", "Education", "High school"],
        ["Profile", "Essay guidance", "Essay length (words)"],
        ["Documents", "Résumé text", "Résumé text"],
        ["Documents", "AI tailoring prompt", "Tailor Prompt"],
        ["AI", "Models", "Claude › Fill › Model"],
        ["Behavior", "Autofill settings", "Overwrite pre-filled fields"],
        ["YOLO Mode", "Schedule", "Applications per batch"],
        ["YOLO Mode", "Review before submission", "Submission Review › Mode"],
      ]),
    );
  });

  it("updates only checked leaves and leaves all other data intact", async () => {
    const profile = emptyProfile();
    profile.personal.firstName = "Current";
    profile.personal.email = "keep@example.com";
    const settings = { ...defaultSettings(), debugLogging: true };
    await store.set({ profile, settings, selectedModel: "keep", yolo: { ...defaultYolo(), enabled: true } });
    const incoming = structuredClone(profile);
    incoming.personal.firstName = "Incoming";
    incoming.personal.email = "replace@example.com";
    const plan = await planFor(data({ profile: incoming }));
    const before = await mock.storage.local.get();
    await applyImportPlan(
      plan,
      pick(plan, (c) => c.path.join(".") === "personal.firstName"),
      store,
    );
    expect(await mock.storage.local.get()).toEqual({
      ...before,
      profile: { ...profile, personal: { ...profile.personal, firstName: "Incoming" } },
    });
  });

  it("selects array records independently, preserves unchecked entries, and imports order explicitly", async () => {
    const a = ProjectSchema.parse({ name: "A", description: "Current A" });
    const b = ProjectSchema.parse({ name: "B" });
    const c = ProjectSchema.parse({ name: "C" });
    const changedA = { ...a, description: "Imported A" };
    await store.set({ profile: { ...emptyProfile(), projects: [a, b] } });
    const plan = await planFor(data({ profile: { ...emptyProfile(), projects: [c, changedA] } }));
    expect(plan.changes.filter((v) => v.path[0] === "projects").map((v) => v.kind)).toEqual([
      "item",
      "item",
      "item",
      "order",
    ]);
    await applyImportPlan(
      plan,
      pick(plan, (v) => v.label === "C"),
      store,
    );
    expect((await store.get("profile")).projects).toEqual([a, b, c]);
    await store.set({ profile: { ...emptyProfile(), projects: [a, b] } });
    await applyImportPlan(plan, all(plan), store);
    expect((await store.get("profile")).projects).toEqual([c, changedA]);
  });

  it("handles reordered and duplicate records without losing or coalescing entries", async () => {
    const a = ExperienceSchema.parse({ title: "Engineer", company: "Same", description: "A" });
    const b = { ...a, description: "B" };
    await store.set({ profile: { ...emptyProfile(), experience: [a, b, a] } });
    const plan = await planFor(data({ profile: { ...emptyProfile(), experience: [b, a, a] } }));
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].kind).toBe("order");
    await applyImportPlan(plan, all(plan), store);
    expect((await store.get("profile")).experience).toEqual([b, a, a]);
  });

  it("lets individual tags be added, kept, removed or reordered", async () => {
    const profile = emptyProfile();
    profile.skills.technical = ["TypeScript", "Python"];
    await store.set({ profile });
    const incoming = structuredClone(profile);
    incoming.skills.technical = ["Rust", "TypeScript"];
    const plan = await planFor(data({ profile: incoming }));
    await applyImportPlan(
      plan,
      pick(plan, (c) => c.label === "Technical skills: Rust"),
      store,
    );
    expect((await store.get("profile")).skills.technical).toEqual(["TypeScript", "Python", "Rust"]);
    await store.set({ profile });
    await applyImportPlan(plan, all(plan), store);
    expect((await store.get("profile")).skills.technical).toEqual(["Rust", "TypeScript"]);
  });

  it("selecting none performs no writes, including the YOLO off safeguard", async () => {
    await store.set({ yolo: { ...defaultYolo(), enabled: true } });
    const plan = await planFor(data({ yolo: { ...defaultYolo(), batchSize: 20 } }));
    const spy = vi.spyOn(store, "set");
    expect(importSelection(plan, new Set()).size).toBe(0);
    await applyImportPlan(plan, new Set(), store);
    expect(spy).not.toHaveBeenCalled();
    expect((await store.get("yolo")).enabled).toBe(true);
  });

  it("makes stopping YOLO explicit and mandatory when any YOLO preference is selected", async () => {
    await store.set({ yolo: { ...defaultYolo(), enabled: true } });
    const plan = await planFor(
      data({ yolo: { ...defaultYolo(), enabled: true, batchSize: 20, email: "skip@example.com" } }),
    );
    const selected = pick(plan, (c) => c.path[0] === "batchSize");
    expect(importSelection(plan, selected).size).toBe(2);
    await applyImportPlan(plan, selected, store);
    expect(await store.get("yolo")).toEqual({ ...defaultYolo(), enabled: false, batchSize: 20 });
  });

  it("retains legacy YOLO review migration and only carries allowlisted browser data", async () => {
    const plan = await planFor(
      data({
        settings: { ...defaultSettings(), reviewFills: false },
        yolo: { batchSize: 7 },
        local: {
          yoloState: { batchAt: 500, queueOnlyBatch: true, gmailConnected: true, pausedUntil: 999 },
          vault: { fake: "do not import" },
          gmailRefresh: { fake: "do not import" },
          schemaVersion: -1,
          keyState: { key: {} },
        },
      }),
    );
    await applyImportPlan(plan, all(plan), store);
    expect(await store.get("yolo")).toMatchObject({
      reviewFills: false,
      aiNavigation: false,
      enabled: false,
      batchSize: 7,
    });
    expect(await store.get("yoloState")).toMatchObject({
      batchAt: 500,
      queueOnlyBatch: true,
      gmailConnected: false,
      pausedUntil: 0,
    });
    expect(await store.get("vault")).toEqual({});
    expect(await store.get("gmailRefresh")).toBe(null);
    expect(await store.get("keyState")).toEqual({});
  });

  it("refuses stale previews before writing, including changed file bytes", async () => {
    const first = doc("first");
    await store.set({ documentsIndex: [first.meta] });
    await store.setDoc("first", first.base64);
    const plan = await planFor(data({ documents: [{ ...first, base64: btoa("new") }] }));
    await store.setDoc("first", btoa("edited while reviewing"));
    const spy = vi.spyOn(store, "set");
    await expect(applyImportPlan(plan, all(plan), store)).rejects.toThrow("Your data changed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows unrelated storage changes during preview", async () => {
    const profile = emptyProfile();
    profile.personal.firstName = "Incoming";
    const plan = await planFor(data({ profile }));
    await store.set({
      selectedModel: "chosen meanwhile",
      yoloState: { ...(await store.get("yoloState")), batchAt: 123 },
    });
    await applyImportPlan(plan, all(plan), store);
    expect((await store.get("profile")).personal.firstName).toBe("Incoming");
    expect(await store.get("selectedModel")).toBe("chosen meanwhile");
    expect((await store.get("yoloState")).batchAt).toBe(123);
  });
});

describe("concurrent import edits", () => {
  it("preserves edits to unchecked fields in the same profile while reviewing", async () => {
    const profile = emptyProfile();
    profile.personal.firstName = "Incoming";
    const plan = await planFor(data({ profile }));
    const latest = emptyProfile();
    latest.personal.email = "edited@example.com";
    latest.projects = [ProjectSchema.parse({ name: "Added meanwhile" })];
    await store.set({ profile: latest });
    await applyImportPlan(plan, all(plan), store);
    expect(await store.get("profile")).toEqual({ ...latest, personal: { ...latest.personal, firstName: "Incoming" } });
  });

  it("requires another review if YOLO is turned on after preview", async () => {
    const plan = await planFor(data({ yolo: { ...defaultYolo(), batchSize: 5 } }));
    await store.set({ yolo: { ...defaultYolo(), enabled: true } });
    await expect(applyImportPlan(plan, all(plan), store)).rejects.toThrow("Your data changed");
    expect((await store.get("yolo")).enabled).toBe(true);
  });

  it("does not restore stale file contents when only document order is selected", async () => {
    const a = doc("a"),
      b = doc("b");
    await store.set({ documentsIndex: [a.meta, b.meta] });
    await store.setDoc("a", a.base64);
    await store.setDoc("b", b.base64);
    const plan = await planFor(data({ documents: [b, a] }));
    await store.setDoc("a", btoa("Edited meanwhile"));
    await expect(
      applyImportPlan(
        plan,
        pick(plan, (c) => c.kind === "order"),
        store,
      ),
    ).rejects.toThrow("Your data changed");
    expect(await store.getDoc("a")).toBe(btoa("Edited meanwhile"));
  });
});

describe("selective document imports", () => {
  it("imports only selected files and commits metadata and file contents together", async () => {
    const keep = doc("keep"),
      added = doc("added");
    await store.set({ documentsIndex: [keep.meta] });
    await store.setDoc("keep", keep.base64);
    const plan = await planFor(data({ documents: [added] }));
    const spy = vi.spyOn(store, "set");
    await applyImportPlan(
      plan,
      pick(plan, (c) => c.label === "added"),
      store,
    );
    expect(await store.get("documentsIndex")).toEqual([keep.meta, added.meta]);
    expect(await store.getDoc("keep")).toBe(keep.base64);
    expect(await store.getDoc("added")).toBe(added.base64);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({
      documentsIndex: [keep.meta, added.meta],
      "doc:added": { base64: added.base64 },
    });
  });

  it("shows and applies explicit document removals, including empty document lists", async () => {
    const old = doc("old");
    await store.set({ documentsIndex: [old.meta] });
    await store.setDoc("old", old.base64);
    const plan = await planFor(data({ documents: [] }));
    expect(plan.changes[0]).toMatchObject({ kind: "document", before: old, after: undefined });
    await applyImportPlan(plan, all(plan), store);
    expect(await store.get("documentsIndex")).toEqual([]);
    expect(await store.getDoc("old")).toBe(null);
  });

  it("blocks selections with multiple primary résumés or reserved IDs before any writes", async () => {
    const old = doc("old", true),
      next = doc("next", true);
    await store.set({ documentsIndex: [old.meta] });
    const plan = await planFor(data({ documents: [next] }));
    const spy = vi.spyOn(store, "set");
    await expect(
      applyImportPlan(
        plan,
        pick(plan, (c) => c.label === "next"),
        store,
      ),
    ).rejects.toThrow("more than one primary");
    expect(spy).not.toHaveBeenCalled();
    const reserved = await planFor(data({ documents: [doc("tailor-tex")] }));
    await expect(applyImportPlan(reserved, all(reserved), store)).rejects.toThrow("reserved");
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps omitted tailoring files, and imports or clears the selected tailoring bundle", async () => {
    const tailoring = {
      info: { fileName: "resume.tex", size: 123, uploadedAt: 1, pages: 1, fallback: null },
      tex: btoa("\\begin{document}Resume\\end{document}"),
      pdf: btoa("pdf"),
      fallbackPdf: undefined,
    };
    const plan = await planFor(data({ tailorResume: tailoring }));
    await applyImportPlan(plan, all(plan), store);
    expect(await store.getDoc("tailor-tex")).toBe(tailoring.tex);
    expect((await planFor(data())).changes).toEqual([]);
    const clear = await planFor(data({ tailorResume: null }));
    expect(clear.changes[0]).toMatchObject({ kind: "tailor", before: tailoring, after: null });
    await applyImportPlan(clear, all(clear), store);
    expect(await store.get("tailorResume")).toBe(null);
    expect(await store.getDoc("tailor-tex")).toBe(null);
  });

  it("rejects unrelated JSON and keeps the version 1 export contract", () => {
    expect(ExportSchema.safeParse({ app: "other", version: 1 }).success).toBe(false);
    expect(ExportSchema.safeParse(data()).success).toBe(true);
  });

  it("invalidates extracted résumé text only for changed or removed documents", async () => {
    const keep = doc("keep"),
      replaced = doc("replaced");
    await store.set({
      documentsIndex: [keep.meta, replaced.meta],
      resumeTexts: { keep: "Keep facts", replaced: "Old facts" },
    });
    await store.setDoc("keep", keep.base64);
    await store.setDoc("replaced", replaced.base64);
    const plan = await planFor(data({ documents: [keep, { ...replaced, base64: btoa("New résumé") }] }));
    await applyImportPlan(plan, all(plan), store);
    expect(await store.get("resumeTexts")).toEqual({ keep: "Keep facts" });
  });

  it("does not partially commit metadata or binary contents when storage rejects the import", async () => {
    const old = doc("old"),
      next = doc("next");
    await store.set({ documentsIndex: [old.meta] });
    await store.setDoc("old", old.base64);
    const plan = await planFor(data({ documents: [next] }));
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error("Storage full"));
    await expect(applyImportPlan(plan, all(plan), store)).rejects.toThrow("Storage full");
    expect(await store.get("documentsIndex")).toEqual([old.meta]);
    expect(await store.getDoc("old")).toBe(old.base64);
    expect(await store.getDoc("next")).toBe(null);
  });

  it("requires the matching API key when selecting an imported key status", async () => {
    const plan = await planFor(
      data({
        apiKeys: [{ id: "new", label: "New", key: "secret", addedAt: 1 }],
        local: { keyState: { new: { successCount: 3, errorCount: 0 } } },
      }),
    );
    await expect(
      applyImportPlan(
        plan,
        pick(plan, (c) => c.key === "keyState"),
        store,
      ),
    ).rejects.toThrow("matching API key");
    expect(await store.get("apiKeys")).toEqual([]);
    await applyImportPlan(plan, all(plan), store);
    expect(await store.get("keyState")).toEqual({ new: { successCount: 3, errorCount: 0 } });
  });

  it("selecting all preserves comprehensive version 1 restore behavior and browser-specific state", async () => {
    const queue = QueueItemSchema.parse({
      key: "job",
      url: "https://jobs.example.test/1",
      company: "Example",
      title: "Engineer",
    });
    const app = ApplicationSchema.parse({ ...queue, status: "submitted", at: 10 });
    const local = {
      yoloQueue: [queue],
      yoloInFlight: queue,
      yoloSourceCheck: { at: 5, doneAt: 7, groups: [] },
      yoloRejected: { job: 2 },
      yoloTabHosts: ["jobs.example.test"],
      employerBoards: { Example: "greenhouse:example" },
      modelListFetchedAt: 8,
      modelCatalog: { model: { firstSeenAt: 1, apiIndex: 0, lastSeenAt: 8 } },
      modelCapabilities: { model: { thinking: { kind: "none" }, schema: "promptOnly", verifiedAt: 8 } },
      keyState: { key: { successCount: 3, errorCount: 1 } },
      yoloState: { batchAt: 9, queueOnlyBatch: true },
    };
    await store.set({ yoloState: { ...(await store.get("yoloState")), gmailConnected: true, pausedUntil: 99 } });
    const plan = await planFor(
      data({
        profile: { ...emptyProfile(), resumeText: "New résumé facts" },
        settings: { ...defaultSettings(), draftEssays: false },
        yolo: { ...defaultYolo(), enabled: true, batchSize: 4 },
        applications: [app],
        selectedModel: "model",
        fallbackModel: "fallback",
        reviewModel: "review",
        apiKeys: [{ id: "key", label: "Key", key: "secret", addedAt: 1 }],
        local,
        documents: [doc("resume", true)],
      }),
    );
    await applyImportPlan(plan, all(plan), store);
    expect(await store.get("applications")).toEqual([app]);
    expect(await store.get("yolo")).toEqual({ ...defaultYolo(), enabled: false, batchSize: 4 });
    expect(await store.get("settings")).toEqual({ ...defaultSettings(), draftEssays: false });
    for (const key of Object.keys(local) as (keyof typeof local)[]) {
      if (key !== "yoloState") expect(await store.get(key)).toEqual(LOCAL_SCHEMAS[key].parse(local[key]));
    }
    expect(await store.get("yoloState")).toMatchObject({
      batchAt: 9,
      queueOnlyBatch: true,
      gmailConnected: true,
      pausedUntil: 99,
    });
    expect(await store.getDoc("resume")).toBe(btoa("resume"));
  });
});
