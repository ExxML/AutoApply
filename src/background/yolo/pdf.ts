// A plain-text PDF (Helvetica, US Letter) for a generated cover letter: no PDF library in the bundle.

const PUNCT: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  "•": "-",
};

/** Latin-1 only (Helvetica's WinAnsi encoding covers it), with typographic punctuation made plain. */
const latin1 = (s: string) => s.replace(/[‘’“”–—…•]/g, (c) => PUNCT[c]).replace(/[^\n\x20-\xff]/g, "");
const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");

export function wrap(text: string, width = 90): string[] {
  return latin1(text)
    .split("\n")
    .flatMap((para) => {
      const out: string[] = [];
      let line = "";
      for (const w of para.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + w.length > width) {
          out.push(line);
          line = w;
        } else line = line ? `${line} ${w}` : w;
      }
      return [...out, line];
    });
}

/** Base64 of the PDF. */
export function textPdf(text: string): string {
  const lines = wrap(text);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 44) pages.push(lines.slice(i, i + 44));
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}]/Count ${pages.length}>>`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
  ];
  pages.forEach((p, i) => {
    const stream = `BT /F1 11 Tf 15 TL 72 720 Td ${p.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + 2 * i} 0 R>>`,
      `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    );
  });
  let pdf = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj${o}endobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return btoa(pdf);
}
