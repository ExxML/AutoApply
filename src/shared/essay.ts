// §15 essay limits: parsing from label/hint and trimming drafts to fit.

export interface EssayLimits {
  maxWords?: number;
  maxChars?: number;
}

export function parseEssayLimits(label: string, hint = "", maxLength?: number): EssayLimits {
  const text = `${label} ${hint}`;
  const w = /(\d+)\s*(words?)/i.exec(text);
  const c = /(\d+)\s*(characters?|chars)/i.exec(text);
  const chars = [c ? Number(c[1]) : undefined, maxLength && maxLength > 0 ? maxLength : undefined].filter(
    (n): n is number => n !== undefined,
  );
  return {
    ...(w ? { maxWords: Number(w[1]) } : {}),
    ...(chars.length ? { maxChars: Math.min(...chars) } : {}),
  };
}

export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(\S.*?\S|\S)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut `text` to at most `limit` units, backing off to the last sentence end when there is one. */
function cutAtSentence(text: string, cut: string): string {
  if (cut.length >= text.length) return text;
  const m = /^[\s\S]*[.!?]["')\]]?(?=\s|$)/.exec(cut);
  return (m && m[0].length > cut.length * 0.3 ? m[0] : cut).trim();
}

export function trimToLimits(text: string, { maxChars, maxWords }: EssayLimits): string {
  let t = text.trim();
  if (maxWords && t.split(/\s+/).length > maxWords) {
    const words = t.split(/(\s+)/);
    t = cutAtSentence(t, words.slice(0, maxWords * 2 - 1).join(""));
  }
  if (maxChars && t.length > maxChars) {
    let cut = t.slice(0, maxChars);
    if (!/\s/.test(t[maxChars] ?? " ")) cut = cut.replace(/\s+\S*$/, "");
    t = cutAtSentence(t, cut);
  }
  return t;
}

export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);
