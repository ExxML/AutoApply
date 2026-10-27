// §10.8.3 essay drafting.
import { stripMarkdown, trimToLimits } from "../../shared/essay";
import type { EssayItem, JobContext, Profile } from "../../shared/types";
import { BadOutputError, BlockedError } from "../gemini/errors";
import { ESSAYS_PROMPT } from "../gemini/prompts";
import { ESSAYS_SCHEMA, EssaysZ } from "../gemini/schemas";
import { compactProfile, type ServiceCtx } from "./mapFields";

export interface EssayResult {
  fieldId: string;
  text: string | null;
  note?: string;
}

export async function draftEssays(
  ctx: ServiceCtx,
  items: EssayItem[],
  profile: Profile,
  job: JobContext | null,
): Promise<EssayResult[]> {
  const { resumeText, learnedAnswers: _l, ...rest } = profile;
  const base = {
    profile: compactProfile(rest) ?? {},
    resume: resumeText.slice(0, 12000),
    job: compactProfile({
      company: job?.company,
      title: job?.jobTitle,
      url: job?.url,
      description: job?.text.slice(0, 8000) || job?.header,
    }),
  };
  const target = (i: EssayItem) =>
    i.maxWords || i.maxChars
      ? undefined
      : i.kind === "cover_letter"
        ? ctx.settings.coverLetterDefaultWords
        : ctx.settings.essayDefaultWords;

  async function run(batch: EssayItem[]): Promise<EssayResult[]> {
    try {
      const r = await ctx.ai.call(
        {
          system: ESSAYS_PROMPT,
          payload: { ...base, items: batch.map((i) => ({ ...i, targetWords: target(i) })) },
          schema: ESSAYS_SCHEMA,
          validate: (d) => EssaysZ.parse(d),
          essay: true,
          timeoutMs: ctx.settings.requestTimeoutMs * 2,
          signal: ctx.signal,
        },
        { model: ctx.model, fallback: ctx.fallback },
      );
      return batch.map((item) => {
        const e = r.data.essays.find((x) => x.fieldId === item.fieldId);
        const text = e ? trimToLimits(stripMarkdown(e.text), item) : "";
        return text
          ? { fieldId: item.fieldId, text }
          : { fieldId: item.fieldId, text: null, note: "No draft returned" };
      });
    } catch (e) {
      if (!(e instanceof BadOutputError || e instanceof BlockedError)) throw e;
      if (batch.length > 1) return (await Promise.all(batch.map((i) => run([i])))).flat();
      return [
        {
          fieldId: batch[0].fieldId,
          text: null,
          note: e instanceof BlockedError ? "AI declined this field" : "Draft failed",
        },
      ];
    }
  }

  const batches: EssayItem[][] = [];
  for (let i = 0; i < items.length; i += 4) batches.push(items.slice(i, i + 4));
  return (await Promise.all(batches.map(run))).flat();
}
