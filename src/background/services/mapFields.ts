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
import { RE_CONSENT } from "../../shared/constants";
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
    return d.action === "fill" && f && !needsNoSource(f)
      ? [{ fieldId: f.id, question: f.label, answer: suggestionOf(d, f) ?? "" }]
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
  let usedModel = ctx.model;

  async function runChunk(chunk: FieldDescriptor[], retried = false): Promise<Decision[]> {
    try {
      const r = await ctx.gemini.call(
        {
          system: MAP_FIELDS_PROMPT,
          payload: { fields: chunk.map((f) => (f.options ? { ...f, options: numbered(f.options) } : f)), ...base },
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
  const chunks: FieldDescriptor[][] = [];
  for (let i = 0; i < input.fields.length; i += size) chunks.push(input.fields.slice(i, i + size));
  const decisions = (await Promise.all(chunks.map((c) => runChunk(c)))).flat();
  return { decisions: await auditFills(ctx, input.fields, base, decisions), usedModel };
}
