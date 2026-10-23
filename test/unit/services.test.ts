import { describe, expect, it } from "vitest";
import { validateDecisions, compactProfile, mapFields } from "../../src/background/services/mapFields";
import { chooseOptions, validateChoices } from "../../src/background/services/chooseOptions";
import { parseEssayLimits, stripMarkdown, trimToLimits, wordCount } from "../../src/shared/essay";
import { BadOutputError } from "../../src/background/gemini/errors";
import type { Gemini } from "../../src/background/gemini/client";
import type { FieldDescriptor } from "../../src/shared/types";
import { defaultSettings } from "../../src/shared/settings";
import { emptyProfile } from "../../src/shared/profileSchema";
import { todayIso } from "../../src/shared/time";

const field = (id: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id,
  kind: "text",
  label: id,
  required: false,
  optionsKnown: true,
  ...extra,
});

describe("response validation (§10.8.1)", () => {
  const fields = [
    field("f1"),
    field("f2", { kind: "radio_group", options: ["Yes", "No"] }),
    field("f3", { kind: "select", options: ["A", "B", "C"] }),
    field("f4", { kind: "checkbox_group", options: ["x", "y", "z"] }),
  ];

  it("drops unknown ids and flags missing ones", () => {
    const out = validateDecisions(fields, [
      { fieldId: "nope", action: "fill", text: "x", confidence: "high", sources: ["personal"] },
      { fieldId: "f1", action: "fill", text: "Ada", confidence: "high", sources: ["personal"] },
    ]);
    expect(out.map((d) => d.fieldId)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(out[0]).toMatchObject({ action: "fill", text: "Ada" });
    expect(out[1]).toMatchObject({ action: "flag", note: "No AI decision" });
  });

  it("turns out-of-range or non-integer indexes into flags", () => {
    const out = validateDecisions(fields, [
      { fieldId: "f2", action: "fill", optionIndexes: [2], confidence: "high", sources: ["personal"] },
      { fieldId: "f3", action: "fill", optionIndexes: [1.5], confidence: "high", sources: ["personal"] },
    ]);
    expect(out[1].action).toBe("flag");
    expect(out[2].action).toBe("flag");
  });

  it("keeps only the first index for single-choice fields but all for multi", () => {
    const out = validateDecisions(fields, [
      { fieldId: "f3", action: "fill", optionIndexes: [2, 0], confidence: "high", sources: ["personal"] },
      { fieldId: "f4", action: "fill", optionIndexes: [0, 2], confidence: "high", sources: ["personal"] },
    ]);
    expect(out[2].optionIndexes).toEqual([2]);
    expect(out[3].optionIndexes).toEqual([0, 2]);
  });

  it("a single-choice decision follows the option the model names over its index", () => {
    const out = validateDecisions(
      [field("y", { kind: "select", options: ["2024", "2028"] })],
      [
        {
          fieldId: "y",
          action: "fill",
          intendedAnswer: "2028",
          optionIndexes: [0],
          confidence: "high",
          sources: ["personal"],
        },
      ],
    );
    expect(out[0].optionIndexes).toEqual([1]);
  });

  it("a skipped required field becomes a flag", () => {
    const out = validateDecisions(
      [field("d", { required: true }), field("o")],
      [
        { fieldId: "d", action: "skip", confidence: "high" },
        { fieldId: "o", action: "skip", confidence: "high" },
      ],
    );
    expect(out.map((d) => d.action)).toEqual(["flag", "skip"]);
  });

  it("a fill citing none of the candidate's data is a guess, left for the user", () => {
    const today = todayIso().split("-");
    const out = validateDecisions(
      [
        field("q1", { kind: "radio_group", options: ["Yes", "No"], label: "Offer deadlines?" }),
        field("q2", { label: "Preferred office" }),
        field("q3", { label: "School" }),
        field("q4", { kind: "file", label: "Transcript" }),
        field("q5", { kind: "checkbox", label: "I agree to the terms" }),
        field("q6", { label: "Date" }),
        field("q7", { kind: "dropdown", label: "Please read the agreement below", options: ["I will read it."] }),
        field("q8", { kind: "dropdown", label: "AI Policy for Application", options: ["Yes", "No"] }),
      ],
      [
        { fieldId: "q1", action: "fill", optionIndexes: [1], confidence: "high", sources: [] },
        { fieldId: "q2", action: "fill", text: "Toronto", confidence: "high", sources: ["job.descriptionExcerpt"] },
        { fieldId: "q3", action: "fill", text: "UBC", confidence: "high", sources: ["profile.education"] },
        { fieldId: "q4", action: "fill", documentId: "t", confidence: "high" },
        { fieldId: "q5", action: "fill", checked: true, confidence: "high" },
        { fieldId: "q6", action: "fill", text: `${today[1]}/${today[2]}/${today[0]}`, confidence: "high" },
        { fieldId: "q7", action: "fill", optionIndexes: [0], confidence: "high", sources: ["profile"] },
        { fieldId: "q8", action: "fill", optionIndexes: [0], confidence: "high", sources: ["profile"] },
      ],
    );
    expect(out.map((d) => d.action)).toEqual(["flag", "flag", "fill", "fill", "fill", "fill", "fill", "fill"]);
    expect(out[0]).toMatchObject({ note: "Not in your profile" });
    expect(out[0].suggestion).toBeUndefined();
  });

  it("low confidence becomes a flag with the suggestion kept", () => {
    const out = validateDecisions(fields, [{ fieldId: "f2", action: "fill", optionIndexes: [0], confidence: "low" }]);
    expect(out[1]).toMatchObject({ action: "flag", suggestion: "Yes" });
  });

  it("chooseOptions validation nulls low-confidence / out-of-range choices", () => {
    const items = [
      { fieldId: "a", question: "q", intendedAnswer: "BC", options: ["Alberta", "British Columbia"], multiple: false },
      { fieldId: "b", question: "q", intendedAnswer: "x", options: ["1"], multiple: false },
      { fieldId: "c", question: "q", intendedAnswer: "x", options: ["1"], multiple: false },
    ];
    const out = validateChoices(items, [
      { fieldId: "a", optionIndexes: [1, 0], confidence: "high" },
      { fieldId: "b", optionIndexes: [5], confidence: "high" },
      { fieldId: "c", optionIndexes: [0], confidence: "low" },
      { fieldId: "zzz", optionIndexes: [0], confidence: "high" },
    ]);
    expect(out).toEqual([
      { fieldId: "a", optionIndexes: [1], confidence: "high" },
      { fieldId: "b", optionIndexes: null, confidence: "low" },
      { fieldId: "c", optionIndexes: null, confidence: "low" },
    ]);
  });
});

describe("mapFields chunking and splitting (§10.7)", () => {
  it("splits a chunk in half when the output is truncated, then flags a single failing field", async () => {
    const sizes: number[] = [];
    const gemini = {
      call: async (s: { payload: { fields: FieldDescriptor[] } }) => {
        const fs = s.payload.fields;
        sizes.push(fs.length);
        if (fs.some((f) => f.id === "bad")) throw new BadOutputError("MAX_TOKENS", true);
        return {
          data: {
            decisions: fs.map((f) => ({
              fieldId: f.id,
              action: "fill",
              text: "x",
              confidence: "high",
              sources: ["personal"],
            })),
          },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const fields = ["a", "b", "bad", "d"].map((id) => field(id));
    const r = await mapFields(
      { gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null },
    );
    expect(r.decisions.map((d) => d.action)).toEqual(["fill", "fill", "flag", "fill"]);
    expect(sizes[0]).toBe(4);
  });

  it("audits the AI's fills: an answer the candidate's data does not support is left blank", async () => {
    const audited: string[][] = [];
    const gemini = {
      call: async (s: { system: string; payload: { fields?: FieldDescriptor[]; items?: { fieldId: string }[] } }) => {
        if (s.system.startsWith("You audit")) {
          audited.push(s.payload.items!.map((i) => i.fieldId));
          return { data: { verdicts: [{ fieldId: "funding", supported: false }] }, usedModel: "m", keyLabel: "k" };
        }
        const decisions = s.payload.fields!.map((f) => ({
          fieldId: f.id,
          action: "fill",
          text: f.id === "heard" ? "Other" : f.id === "status" ? "I require sponsorship" : "No",
          checked: true,
          confidence: "high",
          sources: ["profile.education"],
        }));
        return { data: { decisions }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const fields = [
      field("school"),
      field("funding", { label: "Do you receive active funding?" }),
      field("terms", { kind: "checkbox", label: "I agree to the terms" }),
      field("auth", { label: "Are you authorized to work in the country where you are applying?" }),
      field("heard", { label: "Where did you first hear about this job?" }),
      field("status", { label: "Your work authorization status in the United States" }),
    ];
    const r = await mapFields(
      { gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null },
    );
    expect(audited).toEqual([["school", "funding"]]);
    expect(r.decisions.map((d) => [d.fieldId, d.action])).toEqual([
      ["school", "fill"],
      ["funding", "flag"],
      ["terms", "fill"],
      ["auth", "fill"],
      ["heard", "fill"],
      ["status", "fill"],
    ]);
    expect(r.decisions[1]).toMatchObject({ note: "Not in your profile" });
  });

  it("tells the model which country each work authorization question is about", async () => {
    const sent: Record<string, unknown>[] = [];
    const gemini = {
      call: async (s: { system: string; payload: { fields?: Record<string, unknown>[] } }) => {
        const fields = s.payload.fields ?? [];
        sent.push(...fields);
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.country = "Canada";
    const ask = (location: string, ...labels: string[]) =>
      mapFields(
        { gemini, settings: defaultSettings(), model: "m", fallback: null },
        {
          fields: labels.map((l, i) => field(`f${i}`, { label: l })),
          profile,
          documents: [],
          job: { url: "", title: "", company: "", jobTitle: "", text: "", location, capturedAt: 0 },
        },
      );
    await ask(
      "Dublin, Ireland",
      "Are you legally authorized to work in the country you reside?",
      "Will you now or in the future require Visa Sponsorship?",
      "Are you authorized to work in the U.S.?",
      "Do you require us to sponsor a visa?",
      "First name",
      "Do you currently receive any active funding (e.g., grants, sponsorships)?",
    );
    expect(sent.map((f) => f.workCountry)).toEqual([
      "canada",
      "ireland",
      "united states",
      "ireland",
      undefined,
      undefined,
    ]);
    sent.length = 0;
    await ask("San Francisco, CA; Toronto, ON", "Will you require sponsorship?");
    await ask("San Francisco, CA", "Will you require sponsorship?");
    await ask("Remote (Canada)", "Will you require sponsorship?");
    await ask("Toronto, ON, CA", "Will you require sponsorship?");
    await ask("Atlanta, Georgia", "Will you require sponsorship?");
    expect(sent.map((f) => f.workCountry)).toEqual([undefined, "united states", "canada", "canada", "united states"]);

    // Yes/no questions with a known country are answered from the profile, not asked.
    profile.workAuthorization.entries = [
      {
        country: "Canada",
        authorized: "yes",
        status: "",
        requiresSponsorshipNow: "no",
        requiresSponsorshipFuture: "no",
        notes: "",
      },
    ];
    sent.length = 0;
    const yn = (label: string, options = ["Yes", "No"]) => field(label, { label, kind: "select", options });
    const r = await mapFields(
      { gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          yn("Are you legally authorized to work in the country you reside?"),
          yn("Will you now or in the future require Visa Sponsorship?", ["No, I will not", "Yes, I will"]),
          yn("Are you authorized to work in Canada without sponsorship?"),
          yn("Do you not require sponsorship?"),
          {
            ...yn("Do you require sponsorship in the United States?"),
            kind: "checkbox_group" as const,
            multiple: true,
          },
        ],
        profile,
        documents: [],
        job: { url: "", title: "", company: "", jobTitle: "", text: "", location: "Dublin, Ireland", capturedAt: 0 },
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.action)).toEqual(["Yes", "Yes, I will", "flag", "flag", "Yes"]);
    expect(sent.map((f) => f.id)).toEqual([
      "Are you authorized to work in Canada without sponsorship?",
      "Do you not require sponsorship?",
    ]);
  });

  it("picks the lowest experience bracket when even the total experience is under it", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.experience = [
      {
        title: "",
        company: "",
        location: "",
        employmentType: "",
        startDate: "2026-01",
        endDate: "2026-08",
        current: false,
        description: "",
      },
      {
        title: "",
        company: "",
        location: "",
        employmentType: "",
        startDate: "2023-06",
        endDate: "2023-08",
        current: false,
        description: "",
      },
    ];
    const label = "How Many Years of work experience do you have in your chosen engineering field";
    const r = await mapFields(
      { gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label, kind: "select", options: ["Less than 2", "2,4", "4,6", "12+"] }),
          field("b", { label, kind: "select", options: ["None", "1-2 years", "3-5 years"] }),
          field("c", { label, kind: "select", options: ["0-0.5", "0.5-1", "1-3"] }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    // 11 months: under 2; below "1-2" (with "None" offered) and over 0.5 stay with the model.
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.action)).toEqual(["Less than 2", "flag", "flag"]);
    expect(asked).toEqual(["b", "c"]);
  });

  it("matches the graduation date to an option by year and month or season", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.education = [{ ...profile.education[0], school: "UBC", expectedGraduation: "2028-05" }];
    const label = "What is your anticipated graduation month and year?";
    const ask = (options: string[]) => field(options.join(), { label, kind: "select", options });
    const r = await mapFields(
      { gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          ask(["December 2027", "Spring/Summer 2028", "Other"]),
          ask(["May 2028", "Dec 2028"]),
          ask(["2027", "2028", "2029+"]),
          ask(["Fall 2028", "Winter 2028"]),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.action)).toEqual([
      "Spring/Summer 2028",
      "May 2028",
      "2028",
      "flag",
    ]);
  });

  it("re-asks once for fields the model left out", async () => {
    const sent: string[][] = [];
    const gemini = {
      call: async (s: { payload: { fields: FieldDescriptor[] } }) => {
        const ids = s.payload.fields.map((f) => f.id);
        sent.push(ids);
        const answer = sent.length === 1 ? ids.filter((id) => id !== "b") : ids;
        return {
          data: {
            decisions: answer.map((fieldId) => ({
              fieldId,
              action: "fill",
              text: "x",
              confidence: "high",
              sources: ["personal"],
            })),
          },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields: ["a", "b", "c"].map((id) => field(id)), profile: emptyProfile(), documents: [], job: null },
    );
    expect(sent).toEqual([["a", "b", "c"], ["b"]]);
    expect(r.decisions.map((d) => d.action)).toEqual(["fill", "fill", "fill"]);
  });

  it("a split retry does not earn its halves another retry", async () => {
    const sent: string[][] = [];
    const gemini = {
      call: async (s: { payload: { fields: FieldDescriptor[] } }) => {
        const ids = s.payload.fields.map((f) => f.id);
        sent.push(ids);
        if (sent.length === 2) throw new BadOutputError("Invalid JSON from model");
        const answer = sent.length === 1 ? ["a"] : [];
        return {
          data: {
            decisions: answer.map((fieldId) => ({
              fieldId,
              action: "fill",
              text: "x",
              confidence: "high",
              sources: ["personal"],
            })),
          },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields: ["a", "b", "c"].map((id) => field(id)), profile: emptyProfile(), documents: [], job: null },
    );
    expect(sent).toEqual([["a", "b", "c"], ["b", "c"], ["b"], ["c"]]);
    expect(r.decisions.map((d) => d.note)).toEqual([undefined, "No AI decision", "No AI decision"]);
  });

  it("sends options numbered so the model reads indexes instead of counting", async () => {
    const payloads: Record<string, unknown>[] = [];
    const gemini = {
      call: async (s: { payload: Record<string, unknown> }) => {
        payloads.push(s.payload);
        return { data: { decisions: [], choices: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const ctx = { gemini, settings: defaultSettings(), model: "m", fallback: null };
    const options = ["Canada +1", "Cape Verde +238"];
    await mapFields(ctx, { fields: [field("a", { options })], profile: emptyProfile(), documents: [], job: null });
    await chooseOptions(ctx, [{ fieldId: "b", question: "q", intendedAnswer: "Canada", options, multiple: false }]);
    const want = ["0: Canada +1", "1: Cape Verde +238"];
    expect((payloads[0].fields as FieldDescriptor[])[0].options).toEqual(want);
    expect((payloads.at(-1)!.items as { options: string[] }[])[0].options).toEqual(want);
  });

  it("compactProfile drops empty values recursively", () => {
    expect(compactProfile({ a: "", b: [], c: {}, d: null, e: { f: "", g: "x" }, h: ["", "y"] })).toEqual({
      e: { g: "x" },
      h: ["y"],
    });
  });
});

describe("essay limits (§15)", () => {
  it("parses words and characters from label/hint and maxLength", () => {
    expect(parseEssayLimits("Why us? (max 200 words)")).toEqual({ maxWords: 200 });
    expect(parseEssayLimits("Tell us about you", "Up to 500 characters")).toEqual({ maxChars: 500 });
    expect(parseEssayLimits("Bio", "", 300)).toEqual({ maxChars: 300 });
    expect(parseEssayLimits("Bio 1000 chars", "", 300)).toEqual({ maxChars: 300 });
  });

  it("trims at the last sentence boundary within the limit", () => {
    const text = "One two three. Four five six seven. Eight nine ten eleven twelve.";
    expect(trimToLimits(text, { maxWords: 8 })).toBe("One two three. Four five six seven.");
    const t2 = trimToLimits(text, { maxChars: 40 });
    expect(t2).toBe("One two three. Four five six seven.");
    expect(t2.length).toBeLessThanOrEqual(40);
    expect(wordCount(trimToLimits(text, { maxWords: 3 }))).toBeLessThanOrEqual(3);
    expect(trimToLimits("short", { maxWords: 10, maxChars: 100 })).toBe("short");
  });

  it("strips markdown", () => {
    expect(stripMarkdown("## Title\n**Bold** and *it*\n- item\n[link](http://x)")).toBe(
      "Title\nBold and it\nitem\nlink",
    );
  });
});
