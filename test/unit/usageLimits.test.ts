import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Gemini } from "../../src/background/gemini/client";
import { AllKeysExhaustedError, ClaudeLimitError, ServerError } from "../../src/background/gemini/errors";
import { mapFields, type ServiceCtx } from "../../src/background/services/mapFields";
import { tailor, tailoredResume } from "../../src/background/services/tailorResume";
import { emptyProfile } from "../../src/shared/profileSchema";
import { defaultSettings } from "../../src/shared/settings";
import { createStorage } from "../../src/shared/storage";
import { installChromeMock } from "./chromeMock";

const tex = readFileSync("test/fixtures/latex/jake.tex", "utf8");
const input = {
  fields: [{ id: "q", label: "Research area", kind: "text" as const, required: true, optionsKnown: true }],
  profile: emptyProfile(),
  documents: [],
  job: null,
};
const context = (call: unknown): ServiceCtx => ({
  ai: { call } as Gemini,
  settings: defaultSettings(),
  model: "m",
  fallback: null,
});
const job = {
  company: "Acme",
  jobTitle: "Engineer",
  text: "Build software",
  header: "",
  location: "",
  url: "https://example.com/jobs/1",
  title: "Engineer",
  capturedAt: 1,
};

beforeEach(installChromeMock);

describe.each([
  ["Gemini", () => new AllKeysExhaustedError("m", Date.now() + 300_000, {})],
  ["Claude", () => new ClaudeLimitError(Date.now() + 300_000)],
] as const)("%s usage limits", (_provider, exhausted) => {
  it.each(["audit", "guess"])("does not discard a limit from the %s pass", async (stage) => {
    const error = exhausted();
    const ctx = context(async (spec: { system: string }) => {
      if (spec.system.startsWith(stage === "audit" ? "You audit" : "You complete the fields")) throw error;
      return {
        data: {
          decisions: [
            stage === "audit"
              ? { fieldId: "q", action: "fill", text: "Computing", confidence: "high", sources: ["education"] }
              : { fieldId: "q", action: "flag", confidence: "low", note: "Not in profile" },
          ],
        },
        usedModel: "m",
      };
    });
    await expect(mapFields(ctx, { ...input, yolo: stage === "guess" })).rejects.toBe(error);
  });

  it("does not turn a tailoring limit into untailored edits", async () => {
    const error = exhausted();
    let compiled = false;
    await expect(
      tailor(
        context(async () => {
          throw error;
        }),
        {
          tex,
          pages: 1,
          prompt: "Tailor",
          profile: emptyProfile(),
          job,
        },
        async () => {
          compiled = true;
          return { pdf: "pdf", log: "", pages: 1 };
        },
      ),
    ).rejects.toBe(error);
    expect(compiled).toBe(false);
  });

  it("propagates the tailoring limit through document selection and permits a later retry", async () => {
    const error = exhausted();
    const store = createStorage("background");
    await store.set({
      settings: { ...defaultSettings(), resumeUpload: "tailor" },
      tailorResume: { fileName: "resume.tex", size: tex.length, pages: 1, uploadedAt: 1, fallback: null },
    });
    await store.setDoc("tailor-tex", Buffer.from(tex).toString("base64"));
    await store.setDoc("tailor-pdf", "pdf");
    let calls = 0;
    const ctx = context(async () => {
      calls++;
      throw error;
    });
    await expect(tailoredResume(store, job, async () => ctx)).rejects.toBe(error);
    await expect(tailoredResume(store, job, async () => ctx)).rejects.toBe(error);
    expect(calls).toBe(2);
  });
});

it("keeps the existing fallback for an ordinary audit failure", async () => {
  const ctx = context(async (spec: { system: string }) => {
    if (spec.system.startsWith("You audit")) throw new ServerError("Offline");
    return {
      data: {
        decisions: [{ fieldId: "q", action: "fill", text: "Computing", confidence: "high", sources: ["education"] }],
      },
      usedModel: "m",
    };
  });
  expect((await mapFields(ctx, input)).decisions[0]).toMatchObject({ action: "fill", text: "Computing" });
});
