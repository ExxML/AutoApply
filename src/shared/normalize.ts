/** §13.1: NFKD + strip diacritics, lowercase, & → and, drop punctuation except + and #, collapse spaces. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s+#]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const digitsOnly = (s: string): string => s.replace(/\D/g, "");
export const alnum = (s: string): string => normalize(s).replace(/[^a-z0-9]/g, "");

/** "first_name" / "firstName" / "applicant[first-name]" → "first name". */
export function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-[\].]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n).trimEnd() : s);
export const ellipsize = (s: string, n: number): string => (s.length > n ? `${clip(s, n)}...` : s);

export const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Strip trailing "*" / "✱" (Lever), "(required)", "(optional)" markers and collapse whitespace. */
export function cleanLabel(s: string): string {
  let t = collapse(s);
  for (let i = 0; i < 3; i++) t = t.replace(/\s*(\*|✱|\(required\)|\(optional\))\s*:?$/i, "").trim();
  return t
    .replace(/^\*\s*/, "")
    .replace(/:$/, "")
    .trim();
}
