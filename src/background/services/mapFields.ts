// §10.8.1 main batched mapping call.
import type {
  Decision,
  DocumentMeta,
  FieldDescriptor,
  FieldKind,
  JobContext,
  Profile,
  Settings,
} from "../../shared/types";
import { canonicalCountry, RE_CONSENT, regionCountry } from "../../shared/constants";
import { normalize } from "../../shared/normalize";
import { emptyProfile } from "../../shared/profileSchema";
import { todayIso } from "../../shared/time";
import type { Gemini } from "../gemini/client";
import { BadOutputError, BlockedError } from "../gemini/errors";
import { AUDIT_PROMPT, MAP_FIELDS_PROMPT } from "../gemini/prompts";
import { AUDIT_SCHEMA, AuditZ, MAPPING_SCHEMA, MappingZ, type RawDecision } from "../gemini/schemas";

export interface ServiceCtx {
  gemini: Gemini;
  settings: Settings;
  model: string;
  fallback: string | null;
  signal?: AbortSignal;
}

/** Recursively drops "", [], {} and null. */
export function compactProfile<T>(v: T): T | undefined {
  if (v === null || v === "" || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const a = v.map(compactProfile).filter((x) => x !== undefined);
    return (a.length ? a : undefined) as T | undefined;
  }
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const c = compactProfile(val);
      if (c !== undefined) o[k] = c;
    }
    return (Object.keys(o).length ? o : undefined) as T | undefined;
  }
  return v;
}

const MULTI_KINDS = new Set<FieldKind>(["multiselect", "checkbox_group"]);
const CHOICE_KINDS = new Set<FieldKind>(["select", "multiselect", "radio_group", "checkbox_group", "dropdown"]);

const isMulti = (f: FieldDescriptor) => MULTI_KINDS.has(f.kind) || (f.kind === "dropdown" && !!f.multiple);

function suggestionOf(d: RawDecision, f: FieldDescriptor): string | undefined {
  if (d.text) return d.text;
  if (d.optionIndexes?.length && f.options)
    return d.optionIndexes
      .map((i) => f.options![i])
      .filter(Boolean)
      .join(", ");
  if (d.intendedAnswer) return d.intendedAnswer;
  if (d.checked !== undefined) return d.checked ? "checked" : "unchecked";
  return undefined;
}

const flag = (fieldId: string, note: string, suggestion?: string): Decision => ({
  fieldId,
  action: "flag",
  confidence: "low",
  note,
  ...(suggestion ? { suggestion } : {}),
});

const NOT_IN_PROFILE = "Not in your profile";

// A sponsorship question, not "active funding (e.g., grants, sponsorships)?" (Zoox).
const RE_SPONSOR_Q = /\b(requir|need)\w*\b[^?]*\bsponsor|\bsponsor\w*\b[^?]*\b(visa|immigration|employment|work)\b/i;
const RE_WORK_AUTH = /\b(authori[sz]|visa\b|work permit|right to work|eligible to work)/i;
const isWorkAuth = (label: string) => RE_WORK_AUTH.test(label) || RE_SPONSOR_Q.test(label);
// GitLab: "require sponsorship for a visa to remain in your current location?".
const RE_RESIDENCE = /\b(reside|live|living|currently (located|based)|residence|current (location|country))\b/i;

/** Sources an answer may rest on: the candidate's profile sections, résumé and learned answers. */
const CANDIDATE_DATA = new Set([...Object.keys(emptyProfile()).filter((k) => k !== "resumeText"), "resume"]);
const citesCandidate = (source: string) => CANDIDATE_DATA.has(source.replace(/^profile\./, "").split(/[.[]/)[0]);

/** A signature date: the answer holds today's year, month and day. */
function isToday(text = ""): boolean {
  const nums = (text.match(/\d+/g) ?? []).map(Number);
  return todayIso()
    .split("-")
    .map(Number)
    .every((n) => nums.includes(n));
}

/**
 * The model answers questions the data never covers ("offer deadlines?" → "No") citing nothing, or only the job
 * posting. Those are guesses: leave them to the user. Consents, uploads and signature dates need no profile source.
 */
function guessed(d: Decision, f: FieldDescriptor): boolean {
  if (d.action !== "fill" || d.sources?.some(citesCandidate) || isToday(d.text)) return false;
  return !needsNoSource(f);
}

/** Uploads and acknowledgements: a lone option ("I will read the agreement below"), a policy or agreement, a consent. */
const needsNoSource = (f: FieldDescriptor) =>
  f.kind === "file" ||
  f.options?.length === 1 ||
  /\b(polic(y|ies)|agreement)\b/i.test(f.label) ||
  RE_CONSENT.test(`${f.label} ${f.hint ?? ""} ${(f.options ?? []).join(" ")}`);

/**
 * A work authorization answer for a known country, or a yes/no one: the mapping prompt derives it from the job's
 * country, which the audit won't weigh ("authorized in the country where you are applying?" → "No" for a US job,
 * Waymo's "I require … sponsorship" for Warsaw got flagged).
 */
const workAuthAnswer = (f: FieldDescriptor & { workCountry?: string }, answer: string) =>
  isWorkAuth(f.label) && (!!f.workCountry || /^(yes|no)\b/i.test(answer));

/** "Other" for how they heard: no option matches the profile's source; the audit flagged it (Match Group, Vercel). */
const heardOther = (f: FieldDescriptor, answer: string) =>
  /\b(hear|heard|learn(ed)?) (about|of)\b/i.test(f.label) && /^other\b/i.test(answer);

/** A country the text names. Short codes only as written ("US", "U.S."), never the pronoun "us". */
function countryIn(text: string): string | undefined {
  if (/\bU\.?S\.?(A\.?)?(?![a-z])|\bUnited States\b/.test(text)) return "united states";
  if (/\bUK\b/.test(text)) return "united kingdom";
  const words = normalize(text).split(" ");
  for (let n = 3; n >= 1; n--)
    for (let i = 0; i + n <= words.length; i++) {
      const s = words.slice(i, i + n).join(" ");
      const c = s.length > 3 ? canonicalCountry(s) : null;
      if (c) return c;
    }
}

const US = "united states";
const HUBS: Record<string, string> = {
  "san francisco": US,
  "sf bay area": US,
  "bay area": US,
  "new york": US,
  "new york city": US,
  nyc: US,
  seattle: US,
  austin: US,
  boston: US,
  chicago: US,
  "los angeles": US,
  "palo alto": US,
  "mountain view": US,
  "menlo park": US,
  sunnyvale: US,
  "san jose": US,
  "foster city": US,
  "redwood city": US,
  denver: US,
  atlanta: US,
  toronto: "canada",
  vancouver: "canada",
  montreal: "canada",
  waterloo: "canada",
  ottawa: "canada",
  london: "united kingdom",
  dublin: "ireland",
  berlin: "germany",
  munich: "germany",
  paris: "france",
  amsterdam: "netherlands",
  zurich: "switzerland",
  stockholm: "sweden",
  bangalore: "india",
  bengaluru: "india",
  hyderabad: "india",
  tokyo: "japan",
  sydney: "australia",
  "tel aviv": "israel",
};

/**
 * The one country a job's location names, if just one. Each part narrows the candidates, a state or province first:
 * "San Francisco, CA" → united states, "Toronto, ON, CA" → canada, "Atlanta, Georgia" → united states.
 * With neither, a tech hub's name alone ("Hybrid - San Francisco", Vercel).
 * shortcut: a lone code that is also a state ("Bengaluru, IN") reads as the US state, and hubs are a short list;
 * a full city list would fix both.
 */
function jobCountry(location: string): string | undefined {
  const countries = new Set(
    location.split(";").map((place) => {
      let pick: string[] = [];
      const parts = place.split(/[,()/]| - /);
      for (const p of parts) {
        const options = [regionCountry(p), canonicalCountry(p)].filter((c): c is string => !!c);
        const both = pick.filter((c) => options.includes(c));
        pick = pick.length ? (both.length ? both : pick) : options;
      }
      return pick[0] ?? parts.map((p) => HUBS[normalize(p)]).find(Boolean) ?? null;
    }),
  );
  return countries.size === 1 ? ([...countries][0] ?? undefined) : undefined;
}

/**
 * The country a work authorization question is about: the one it names, the candidate's own for "where you live",
 * else the job's. The model mixed these up ("authorized in the country you reside?" → the job's country).
 */
function workCountry(label: string, home: string, job: string | undefined): string | undefined {
  if (!isWorkAuth(label)) return undefined;
  return (
    countryIn(label) ?? ((RE_RESIDENCE.test(label) ? (canonicalCountry(home) ?? normalize(home)) : job) || undefined)
  );
}

const SITES: [RegExp, string[]][] = [
  ...["github", "gitlab", "bitbucket", "linkedin", "replit", "kaggle", "leetcode", "devpost", "huggingface"].map(
    (s): [RegExp, string[]] => [new RegExp(`\\b${s}\\b`, "i"), [s]],
  ),
  [/\b(twitter|x\.com)\b/i, ["twitter", "x.com"]],
  [/\bhugging face\b/i, ["huggingface"]],
];

/**
 * A link for a field that names one site, pointing elsewhere: Replit's "Replit Profile URL" got the GitHub URL and
 * the audit let it through. Fields that also take any site ("LinkedIn, personal website or blog") are left alone.
 */
function wrongSiteLink(label: string, answer: string, sources: string[] = []): boolean {
  if (/website|portfolio|blog|personal|other|\bor\b/i.test(label)) return false;
  const named = SITES.filter(([re]) => re.test(label));
  const onSite = (x: string) => named.some(([, hosts]) => hosts.some((h) => x.includes(h)));
  const host = answer.match(/^https?:\/\/([^/\s]+)/i)?.[1]?.toLowerCase();
  // A username taken from another site's link: GitLab's "What is your GitLab username?" got the GitHub handle.
  const cited = sources.flatMap((s) => s.match(/links\.(\w+)/)?.[1] ?? []);
  return named.length > 0 && (host ? !onSite(host) : cited.length > 0 && !cited.some(onSite));
}

const entryFor = (country: string, entries: Profile["workAuthorization"]["entries"]) =>
  entries.find((x) => (canonicalCountry(x.country) ?? normalize(x.country)) === country);

/**
 * An AI answer of "None"/"No" to a sponsorship question for a country where the profile needs sponsorship (no entry,
 * or one requiring it). Notion's "will you require any of the below sponsorship? J1 / F1 / None / Other" got "None".
 */
function deniesNeededSponsorship(
  f: FieldDescriptor,
  answer: string,
  country: string | undefined,
  entries: Profile["workAuthorization"]["entries"],
): boolean {
  if (!country || !RE_SPONSOR_Q.test(f.label) || !/^(none|no|n\/?a|not applicable)\b/i.test(answer)) return false;
  const e = entryFor(country, entries);
  return !e || e.requiresSponsorshipNow === "yes" || e.requiresSponsorshipFuture === "yes";
}

/**
 * Yes/no "authorized to work?" / "require sponsorship?" questions with a known country, answered from the profile.
 * The model, even told the country, still answered from the home country's entry (Okta, Dublin: "require
 * sponsorship?" → "No"). Negated or combined questions ("authorized without sponsorship?") stay with the model.
 */
function workAuthDecision(
  f: FieldDescriptor,
  country: string | undefined,
  entries: Profile["workAuthorization"]["entries"],
): Decision | null {
  // A text box asking a yes/no question takes "Yes"/"No" (Zoox: "Do you require sponsorship ...?").
  const text = f.kind === "text" && /^(are|do|does|will|would|have|is|can)\b.*\?$/i.test(f.label.trim());
  // Lever asks yes/no as a two-box checkbox group (Zoox).
  if (!country || (!f.options && !text) || (isMulti(f) && f.options?.length !== 2) || /\bnot\b|n['’]t\b/i.test(f.label))
    return null;
  const sponsor = RE_SPONSOR_Q.test(f.label);
  const authorized = /authori[sz]ed|eligible to work|right to work/i.test(f.label);
  if (sponsor === authorized || (authorized && /sponsor/i.test(f.label))) return null;
  const only = (re: RegExp) => {
    const hits = (f.options ?? []).flatMap((o, i) => (re.test(o) ? [i] : []));
    return hits.length === 1 ? hits[0] : -1;
  };
  const yes = only(/^yes\b/i);
  const no = only(/^no\b/i);
  if (!text && (yes < 0 || no < 0)) return null;
  const e = entryFor(country, entries);
  // No entry for the country: not authorized there, so sponsorship needed.
  const says = !e
    ? [sponsor ? "yes" : "no"]
    : sponsor
      ? [e.requiresSponsorshipNow, ...(/future/i.test(f.label) ? [e.requiresSponsorshipFuture] : [])]
      : [e.authorized];
  const answer = says.includes("yes") ? true : says.every((s) => s === "no") ? false : null;
  if (answer === null) return null;
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["workAuthorization"] };
  if (text) return { ...base, text: answer ? "Yes" : "No" };
  const i = answer ? yes : no;
  return { ...base, optionIndexes: [i], intendedAnswer: f.options![i] };
}

/** Months of work experience in the profile, end dates included ("2026-01" to "2026-08" is 8). */
function experienceMonths(experience: Profile["experience"]): number {
  const month = (d: string) => {
    const [y, m] = d.split("-").map(Number);
    return y * 12 + (m || 1) - 1;
  };
  return experience.reduce((sum, e) => {
    const end = e.current || !e.endDate ? todayIso() : e.endDate;
    return e.startDate ? sum + Math.max(0, month(end) - month(e.startDate) + 1) : sum;
  }, 0);
}

/**
 * "How many years of experience?" when even the candidate's total experience is under the lowest bracket's top
 * ("Less than 2", "0-1 years"): relevant experience can only be less. The model picked "2,4" for 11 months.
 */
function experienceDecision(f: FieldDescriptor, months: number): Decision | null {
  if (!f.options || isMulti(f) || !/\bhow many years\b|\byears of\b.*\bexperience\b/i.test(f.label)) return null;
  const tops = f.options.map((o) => {
    const n = (o.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    if (/^(less than|under|fewer than|<)/i.test(o.trim()) && n.length === 1) return { low: 0, top: n[0] };
    if (n.length === 2 && n[0] < n[1]) return { low: n[0], top: n[1] };
    return null;
  });
  const lows = tops.flatMap((t) => (t ? [t.low] : []));
  const i = tops.findIndex((t) => t && t.low === Math.min(...lows));
  // Below the lowest bracket's floor too ("1-2" when there is also "None"): the model decides.
  if (i < 0 || months / 12 >= tops[i]!.top || months / 12 < tops[i]!.low) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["experience"],
  };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SEASONS: [RegExp, number[]][] = [
  [/\bspring\b/i, [3, 4, 5]],
  [/\bsummer\b/i, [6, 7, 8]],
  [/\b(fall|autumn)\b/i, [9, 10, 11]],
  [/\bwinter\b/i, [12, 1, 2]],
];

/**
 * A graduation date among options, matched by year and month or season ("2028-05" → "Spring/Summer 2028"). The
 * model picked "Other" for Lyft's "anticipated graduation month and year?" with the note "Graduation is May 2028".
 */
function graduationDecision(f: FieldDescriptor, education: Profile["education"]): Decision | null {
  const when = education.find((e) => e.expectedGraduation || e.endDate);
  if (!f.options || isMulti(f) || !/graduat/i.test(f.label) || /high school|secondary/i.test(f.label) || !when)
    return null;
  const [year, month] = (when.expectedGraduation || when.endDate).split("-").map(Number);
  const hits = f.options.flatMap((o, i) => {
    if (!new RegExp(`\\b${year}\\b`).test(o)) return [];
    const names = MONTHS.filter((m) => new RegExp(`\\b${m}`, "i").test(o));
    const seasons = SEASONS.filter(([re]) => re.test(o));
    if (!names.length && !seasons.length) return [i];
    return names.includes(MONTHS[month - 1]) || seasons.some(([, ms]) => ms.includes(month)) ? [i] : [];
  });
  if (hits.length !== 1) return null;
  const i = hits[0];
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["education"],
  };
}

/**
 * A second look at the AI's fills, judged against the candidate's data alone: it also catches guesses citing an
 * unrelated profile section ("active funding?" → "No", cited to education). Fails open: the fills stand.
 */
async function auditFills(
  ctx: ServiceCtx,
  fields: FieldDescriptor[],
  base: ReturnType<typeof mappingPayloadBase>,
  decisions: Decision[],
): Promise<Decision[]> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const items = decisions.flatMap((d) => {
    const f = byId.get(d.fieldId);
    const answer = f && suggestionOf(d, f);
    return d.action === "fill" &&
      f &&
      !needsNoSource(f) &&
      !workAuthAnswer(f, answer ?? "") &&
      !heardOther(f, answer ?? "")
      ? [{ fieldId: f.id, question: f.label, answer: answer ?? "" }]
      : [];
  });
  if (!items.length) return decisions;
  try {
    const { profile, resume, learnedAnswers, job, today } = base;
    const r = await ctx.gemini.call(
      {
        system: AUDIT_PROMPT,
        payload: { items, profile, resume, learnedAnswers, job, today },
        schema: AUDIT_SCHEMA,
        validate: (d) => AuditZ.parse(d),
        timeoutMs: ctx.settings.requestTimeoutMs,
        signal: ctx.signal,
      },
      { model: ctx.model, fallback: ctx.fallback },
    );
    const unsupported = new Set(r.data.verdicts.filter((v) => !v.supported).map((v) => v.fieldId));
    return decisions.map((d) =>
      d.action === "fill" && unsupported.has(d.fieldId) ? flag(d.fieldId, NOT_IN_PROFILE) : d,
    );
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return decisions;
  }
}

/** Validates AI decisions against what was sent (§10.8.1, §18.3). */
export function validateDecisions(fields: FieldDescriptor[], raw: RawDecision[]): Decision[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out = new Map<string, Decision>();
  for (const r of raw) {
    const f = byId.get(r.fieldId);
    if (!f || out.has(r.fieldId)) continue;
    let d: Decision = { ...r };
    if (d.action === "fill" && CHOICE_KINDS.has(f.kind) && f.optionsKnown && f.options?.length) {
      // The option the model names beats its index, which it gets wrong in numeric lists (meant 2028, sent "2: 2024").
      const said = d.intendedAnswer && !isMulti(f) ? normalize(d.intendedAnswer) : "";
      const named = said ? f.options.findIndex((o) => normalize(o) === said) : -1;
      if (named >= 0) d.optionIndexes = [named];
      const idx = d.optionIndexes;
      if (!idx?.length) {
        if (!(f.kind === "dropdown" && d.intendedAnswer)) d = flag(f.id, "No option chosen", suggestionOf(r, f));
      } else if (idx.some((i) => !Number.isInteger(i) || i < 0 || i >= f.options!.length)) {
        d = flag(f.id, "AI chose an invalid option", d.intendedAnswer);
      } else if (!isMulti(f) && idx.length > 1) {
        d.optionIndexes = [idx[0]];
      }
    }
    // A required field left blank blocks the application: the user must see it.
    if (d.action === "skip" && f.required) d = flag(f.id, r.note || "Required field", suggestionOf(r, f));
    if (d.action === "fill" && d.confidence === "low") d = flag(f.id, r.note || "Low confidence", suggestionOf(r, f));
    if (d.action === "flag" && !d.suggestion && r.action !== "flag") d.suggestion = suggestionOf(r, f);
    // No suggestion either: it would only be the guess.
    if (guessed(d, f)) d = flag(f.id, NOT_IN_PROFILE);
    out.set(f.id, d);
  }
  return fields.map((f) => out.get(f.id) ?? flag(f.id, "No AI decision"));
}

export interface MapInput {
  fields: FieldDescriptor[];
  profile: Profile;
  documents: DocumentMeta[];
  job: JobContext | null;
}

// The model miscounts positions in long lists (picked "Cape Verde +238", the option after "Canada +1"),
// so each option carries its index for the model to read back.
export const numbered = (options: string[]) => options.map((o, i) => `${i}: ${o}`);

export function mappingPayloadBase(input: Omit<MapInput, "fields">) {
  const { resumeText, learnedAnswers, ...rest } = input.profile;
  return {
    profile: compactProfile(rest) ?? {},
    resume: resumeText.slice(0, 12000),
    learnedAnswers: [...learnedAnswers]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, 100)
      // Recency picks which 100; createdAt orders them so the prompt doesn't reshuffle after every fill.
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((l) => ({ q: l.question, a: l.answer })),
    documents: input.documents.map(({ id, label, kind }) => ({ id, label, kind })),
    job: compactProfile({
      company: input.job?.company,
      title: input.job?.jobTitle,
      url: input.job?.url,
      location: input.job?.location,
      descriptionExcerpt: input.job?.text.slice(0, 3000) || input.job?.header,
    }),
    today: todayIso(),
  };
}

export async function mapFields(
  ctx: ServiceCtx,
  input: MapInput,
): Promise<{ decisions: Decision[]; usedModel: string }> {
  const base = mappingPayloadBase(input);
  const home = input.profile.personal.address.country;
  const job = input.job?.location ? jobCountry(input.job.location) : undefined;
  const countries = new Map(input.fields.map((f) => [f.id, workCountry(f.label, home, job)]));
  const months = experienceMonths(input.profile.experience);
  const local = new Map<string, Decision>();
  for (const f of input.fields) {
    const d =
      workAuthDecision(f, countries.get(f.id), input.profile.workAuthorization.entries) ??
      experienceDecision(f, months) ??
      graduationDecision(f, input.profile.education);
    if (d) local.set(f.id, d);
  }
  const sent = (f: FieldDescriptor) => {
    const country = countries.get(f.id);
    return {
      ...f,
      ...(f.options ? { options: numbered(f.options) } : {}),
      ...(country ? { workCountry: country } : {}),
    };
  };
  let usedModel = ctx.model;

  async function runChunk(chunk: FieldDescriptor[], retried = false): Promise<Decision[]> {
    try {
      const r = await ctx.gemini.call(
        {
          system: MAP_FIELDS_PROMPT,
          payload: { fields: chunk.map(sent), ...base },
          schema: MAPPING_SCHEMA,
          validate: (d) => MappingZ.parse(d),
          timeoutMs: ctx.settings.requestTimeoutMs,
          signal: ctx.signal,
        },
        { model: ctx.model, fallback: ctx.fallback },
      );
      if (r.usedModel !== ctx.model) usedModel = r.usedModel;
      const decisions = validateDecisions(chunk, r.data.decisions);
      // The model sometimes drops fields from long batches; ask once more for just those.
      const answered = new Set(r.data.decisions.map((d) => d.fieldId));
      const missing = chunk.filter((f) => !answered.has(f.id));
      if (!missing.length || retried) return decisions;
      const again = new Map((await runChunk(missing, true)).map((d) => [d.fieldId, d]));
      return decisions.map((d) => again.get(d.fieldId) ?? d);
    } catch (e) {
      if (!(e instanceof BadOutputError || e instanceof BlockedError)) throw e;
      if (chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2);
        return (
          await Promise.all([runChunk(chunk.slice(0, mid), retried), runChunk(chunk.slice(mid), retried)])
        ).flat();
      }
      if (e instanceof BadOutputError && !retried) return runChunk(chunk, true);
      return [flag(chunk[0].id, e instanceof BlockedError ? "AI declined this field" : "AI response was invalid")];
    }
  }

  const size = ctx.settings.maxFieldsPerRequest;
  const asked = input.fields.filter((f) => !local.has(f.id));
  const chunks: FieldDescriptor[][] = [];
  for (let i = 0; i < asked.length; i += size) chunks.push(asked.slice(i, i + size));
  const decisions = (await Promise.all(chunks.map((c) => runChunk(c)))).flat();
  const withCountry = asked.map((f) => ({ ...f, workCountry: countries.get(f.id) }));
  const answered = new Map((await auditFills(ctx, withCountry, base, decisions)).map((d) => [d.fieldId, d]));
  const entries = input.profile.workAuthorization.entries;
  return {
    decisions: input.fields.map((f) => {
      const d = local.get(f.id) ?? answered.get(f.id)!;
      const answer = d.action === "fill" ? (suggestionOf(d, f) ?? "") : "";
      if (deniesNeededSponsorship(f, answer, countries.get(f.id), entries))
        return flag(f.id, "Sponsorship needed in this country", answer);
      return wrongSiteLink(f.label, answer, d.sources) ? flag(f.id, NOT_IN_PROFILE, answer) : d;
    }),
    usedModel,
  };
}
