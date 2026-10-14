import { expect, seed, storage, test } from "./extension";

/** Builds a one-page PDF whose content stream draws `text` (with a correct xref table). */
function pdfWithText(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj${o}endobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

test("documents: uploading a PDF résumé stores it as primary and extracts its text with pdf.js", async ({
  page,
  sw,
}) => {
  await seed(sw);
  await sw.evaluate(() => chrome.storage.local.set({ documentsIndex: [] }));
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/documents`);
  await page.getByLabel("File (PDF, DOCX or TXT, max 5 MB)").setInputFiles({
    name: "cv.pdf",
    mimeType: "application/pdf",
    buffer: pdfWithText("Ada Lovelace Analytical Engine"),
  });
  await expect(page.getByRole("radio", { name: /primary résumé/ })).toBeChecked();
  await expect(page.getByLabel("Extracted text (editable)")).toHaveValue(/Ada Lovelace Analytical Engine/);
  await expect
    .poll(async () => (await storage<{ resumeText: string }>(sw, "profile")).resumeText)
    .toContain("Ada Lovelace Analytical Engine");
});
