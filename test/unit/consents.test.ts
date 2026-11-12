import { describe, expect, it, vi } from "vitest";
import { mapFields, localDecisions } from "../../src/background/services/mapFields";
import { profileConsentAnswer } from "../../src/shared/constants";
import { profileConsentDecision } from "../../src/shared/consents";
import { emptyProfile } from "../../src/shared/profileSchema";
import { defaultSettings } from "../../src/shared/settings";
import type { FieldDescriptor } from "../../src/shared/types";

const topics = [
  ["consentToInterviewRecording", "I consent to recording my interview."],
  ["consentToAiReview", "I consent to AI tools reviewing my application."],
  ["consentToJobOpportunities", "I agree to receive alerts about new job opportunities."],
  ["consentToMarketing", "I agree to receive marketing communications."],
] as const;
const field = (extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: "consent",
  label: topics[0][1],
  kind: "select",
  options: ["Yes", "No"],
  optionsKnown: true,
  required: false,
  ...extra,
});

describe("Profile consent precedence", () => {
  it.each([false, true])("ignores Behaviour settings for every Profile consent (YOLO %s)", async (yolo) => {
    const ai = { call: vi.fn().mockRejectedValue(new Error("Profile consents must not use AI")) };
    for (const optionalConsents of ["accept", "decline", "ask"] as const)
      for (const autoAcceptAcknowledgements of [false, true])
        for (const required of [false, true])
          for (const answer of ["yes", "no", ""] as const) {
            const profile = emptyProfile();
            for (const [key] of topics) profile.background[key] = answer;
            const fields = topics.flatMap(([, label], i) => [
              field({ id: `choice${i}`, label, required }),
              field({ id: `box${i}`, label, required, kind: "checkbox", options: undefined }),
            ]);
            const result = await mapFields(
              {
                ai,
                settings: { ...defaultSettings(), optionalConsents, autoAcceptAcknowledgements },
                model: "m",
                fallback: null,
              },
              { fields, profile, documents: [], job: null, yolo },
            );
            for (const [i, decision] of result.decisions.entries())
              expect(decision).toMatchObject(
                answer === ""
                  ? { action: "flag" }
                  : i % 2
                    ? { action: "fill", checked: answer === "yes" }
                    : { action: "fill", intendedAnswer: answer === "yes" ? "Yes" : "No" },
              );
          }
    expect(ai.call).not.toHaveBeenCalled();
  });

  it("requires every combined topic to be accepted, declines any No, and never borrows Behaviour for Unset", () => {
    const text =
      "I consent to recording my interview, AI tools reviewing my application, and receiving marketing communications and new job opportunities.";
    const prefs = emptyProfile().background;
    for (const [key] of topics) prefs[key] = "yes";
    expect(profileConsentAnswer(text, prefs)).toBe("yes");
    for (const [key] of topics) {
      expect(profileConsentAnswer(text, { ...prefs, [key]: "no" })).toBe("no");
      expect(profileConsentAnswer(text, { ...prefs, [key]: "" })).toBe("");
    }
    expect(profileConsentAnswer(text, { ...prefs, consentToMarketing: "", consentToAiReview: "no" })).toBe("no");
  });

  it("handles consent wording, delayed dropdowns and missing matching options conservatively", () => {
    const prefs = { ...emptyProfile().background, consentToInterviewRecording: "no" as const };
    expect(profileConsentDecision(field({ options: ["Consent", "Do Not Consent"] }), prefs)).toMatchObject({
      optionIndexes: [1],
    });
    expect(
      profileConsentDecision(field({ kind: "dropdown", options: undefined, optionsKnown: false }), prefs),
    ).toMatchObject({ intendedAnswer: "No" });
    expect(profileConsentDecision(field({ options: ["I agree"] }), prefs)).toMatchObject({ action: "flag" });
    expect(profileConsentDecision(field({ options: ["Maybe", "Later"] }), prefs)).toMatchObject({ action: "flag" });
    expect(
      profileConsentDecision(
        field({
          label: "Would you like to receive job alerts?",
          options: ["Yes, please send me job alerts", "No, please do not contact me"],
        }),
        { ...prefs, consentToJobOpportunities: "yes" },
      ),
    ).toMatchObject({ optionIndexes: [0] });
  });

  it("leaves unrelated consents and candidate facts alone, and keeps AI-use guards first", () => {
    const profile = emptyProfile();
    for (const [key] of topics) profile.background[key] = "yes";
    for (const label of [
      "I agree to the Terms of Service",
      "Receive SMS updates about this application?",
      "Have you used AI tools to screen candidates?",
      "Do you have experience in marketing communications?",
    ])
      expect(profileConsentDecision(field({ label }), profile.background)).toBeNull();
    expect(
      profileConsentDecision(
        field({
          label: "On-site availability every day? In case you are considered for other open positions.",
          options: ["Yes, I live near the office and can go every day.", "No, I can't go every day."],
        }),
        profile.background,
      ),
    ).toBeNull();
    const f = field({
      label: "I consent to AI tools reviewing my application. I will not use AI to prepare my application.",
    });
    expect(localDecisions({ fields: [f], profile, documents: [], job: null }).get(f.id)).toMatchObject({
      action: "flag",
      note: "Asks about AI use in this application: answer it yourself",
    });
  });
});
