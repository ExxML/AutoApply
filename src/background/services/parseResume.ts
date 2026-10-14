// §10.9 résumé → profile prefill (JSON mode without responseSchema; the profile schema is too large).
import { ProfileSchema, type Profile } from "../../shared/profileSchema";
import { parseResumeSystem } from "../gemini/prompts";
import type { ServiceCtx } from "./mapFields";

export async function parseResume(ctx: ServiceCtx, resumeText: string): Promise<Partial<Profile>> {
  const r = await ctx.gemini.call(
    {
      system: parseResumeSystem(),
      payload: resumeText.slice(0, 30000),
      validate: (d) => ProfileSchema.parse(d),
      timeoutMs: ctx.settings.requestTimeoutMs * 2,
      maxOutputTokens: 16384,
    },
    { model: ctx.model, fallback: ctx.fallback },
  );
  const { learnedAnswers: _l, resumeText: _r, ...rest } = r.data;
  return rest;
}
