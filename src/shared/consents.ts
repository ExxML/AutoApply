import {
  isAiReview,
  profileConsentAnswer,
  RE_CONSENT,
  RE_INTERVIEW_RECORDING,
  RE_OPTIONAL_CONSENT,
  type ProfileConsents,
} from "./constants";
import type { Decision, FieldDescriptor } from "./types";

/** Independent consent boxes, rather than several possible answers to one consent question. */
export function consentBoxes(f: FieldDescriptor, prefs: ProfileConsents): boolean {
  return (
    f.kind === "checkbox_group" &&
    !!f.options?.length &&
    f.options.every((o) => profileConsentAnswer(o, prefs) !== null || RE_CONSENT.test(o) || RE_OPTIONAL_CONSENT.test(o))
  );
}

/** Also protect Profile consents inside a mixed group with a generic heading such as "Preferences". */
export function matchesProfileConsent(f: FieldDescriptor, prefs: ProfileConsents): boolean {
  const text = `${f.label} ${f.hint ?? ""}`;
  // Long answers stating facts about the candidate are not outreach opt-ins merely because a hint mentions roles.
  if (
    f.kind !== "checkbox_group" &&
    f.options?.some((o) => o.split(/\s+/).length > 3) &&
    !RE_CONSENT.test(text) &&
    !RE_INTERVIEW_RECORDING.test(text) &&
    !isAiReview(text) &&
    profileConsentAnswer(text.split("?")[0], prefs) === null
  )
    return false;
  return (
    profileConsentAnswer(text, prefs) !== null ||
    (consentBoxes(f, prefs) && f.options!.some((o) => profileConsentAnswer(o, prefs) !== null))
  );
}

/** The same decision for the initial mapping and review, before any AI answer or Behaviour consent setting. */
export function profileConsentDecision(f: FieldDescriptor, prefs: ProfileConsents): Decision | null {
  if (!matchesProfileConsent(f, prefs)) return null;
  const base = { fieldId: f.id, confidence: "high" as const, sources: ["background"] };
  // Mixed boxes need the consent handler's settings for the boxes that Profile does not own.
  if (consentBoxes(f, prefs)) return { ...base, action: "consent" };
  const answer = profileConsentAnswer(`${f.label} ${f.hint ?? ""}`, prefs);
  const flag = (note: string): Decision => ({ ...base, action: "flag", note });
  if (!answer) return flag("Consent not set in your Profile");
  if (f.kind === "checkbox") return { ...base, action: "fill", checked: answer === "yes" };
  if (!f.options && (f.kind === "dropdown" || f.kind === "typeahead"))
    return { ...base, action: "fill", intendedAnswer: answer === "yes" ? "Yes" : "No" };
  if (f.multiple || f.kind === "checkbox_group" || f.kind === "multiselect")
    return flag("Confirm the choices for your Profile consent preference");
  const re =
    answer === "yes"
      ? /^(yes\b|(i )?(consent|agree|accept|acknowledge)\b|opt[ -]?in\b)/i
      : /^(no\b|(i )?(do not|don['’]t|decline|disagree|refuse|withhold)\b|opt[ -]?out\b)/i;
  const hits = f.options?.flatMap((o, i) => (re.test(o.trim()) ? [i] : [])) ?? [];
  // Two-way data-use choices: ANY ROLES / ONLY THE ROLE I AM APPLYING FOR.
  if (!hits.length && f.options?.length === 2) {
    const only = f.options.map((o) => /\bonly\b/i.test(o));
    if (only[0] !== only[1]) hits.push(only.indexOf(answer === "no"));
  }
  return hits.length === 1
    ? { ...base, action: "fill", optionIndexes: hits, intendedAnswer: f.options![hits[0]] }
    : flag("No unambiguous option matches your Profile consent preference");
}

const RE_AI = String.raw`\b(AI|artificial intelligence|ChatGPT|LLMs?|generative)\b`;
const RE_AI_USE = new RegExp(
  String.raw`\bI (have |will |did |do )?(not|never)\b[^?.]*\buse\b[^?.]*${RE_AI}|\b(did|have) you (use|used)\b[^?]*${RE_AI}` +
    // Clever: "we do not permit candidates to use generative AI ... to draft responses"; Attentive: "If you are an AI
    // Agent" (not LangChain's "Have you built AI agents?").
    String.raw`|\bnot (permit|allow)\w*\b[^?.]*\b(use|using)\b[^?.]*${RE_AI}|\b(are|you're) an? AI agent\b` +
    // Medium: "You confirm that ... no portion of the following responses were generated using the assistance of AI".
    String.raw`|\bgenerated\b[^?.]*\b(using|with|by)\b[^?.]*${RE_AI}` +
    // Calendly: "Was this application prepared or submitted in whole or in part by an AI system …?".
    String.raw`|\b(prepared|submitted|completed|written)\b[^?.]*\bby\b[^?.]*${RE_AI}`,
  "i",
);

/**
 * Questions about AI use or automation in the application itself are the user's to answer, never ours: Peloton's
 * "I have not, and I will not, use AI tools during the application" got "Yes"; Grafana asks "I am an AI or automated
 * program" / "I am a human being".
 */
export function aiUseDecision(f: FieldDescriptor): Decision | null {
  // "I am an AI or automated program" / "I am a human being"; not StackAdapt's "I am an advanced AI user".
  const bot =
    f.options?.some((o) => /^(I am|I'm) (an? )?(AI|bot|automated)\b/i.test(o)) &&
    f.options.some((o) => /^(I am|I'm) (a )?human\b/i.test(o));
  return bot || RE_AI_USE.test(f.label)
    ? {
        fieldId: f.id,
        action: "flag",
        confidence: "low",
        note: "Asks about AI use in this application: answer it yourself",
      }
    : null;
}
