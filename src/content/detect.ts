// §11.2 detection score (0–100).
import {
  isAtsHost,
  RE_JOB_TITLE,
  RE_JOB_URL,
  RE_RESUME_FILE,
  RE_SUBMIT_TEXT,
  LABEL_RULES,
  RE_DROPZONE,
} from "../shared/constants";
import { collapse } from "../shared/normalize";
import { containerText, type FieldHandle } from "./scan/fields";
import { deepQueryAll } from "./scan/traverse";
import { isVisible } from "./scan/visibility";

export interface Detection {
  score: number;
  signals: string[];
}

const NAME_EMAIL_PHONE = /^(first\s*name|last\s*name|(full\s*)?name|e-?mail|phone|mobile)/i;

export function detect(handles: FieldHandle[], loc: Location = location, doc: Document = document): Detection {
  let score = 0;
  const signals: string[] = [];
  const add = (pts: number, why: string) => {
    score += pts;
    signals.push(`${pts > 0 ? "+" : ""}${pts} ${why}`);
  };

  if (isAtsHost(loc.hostname, loc.pathname)) add(35, "ATS host");
  if (RE_JOB_URL.test(loc.pathname + loc.search)) add(15, "URL");
  const headings = [...doc.querySelectorAll("h1,h2,h3")].map((h) => collapse(h.textContent ?? ""));
  if (RE_JOB_TITLE.test(doc.title) || headings.some((h) => RE_JOB_TITLE.test(h))) add(10, "title/heading");

  const resumeFile = handles.some(
    (h) =>
      (h.desc.kind === "file" && (RE_RESUME_FILE.test(h.desc.label) || RE_RESUME_FILE.test(containerText(h)))) || false,
  );
  const dropzone =
    !resumeFile &&
    deepQueryAll('[class*="drop" i],[class*="upload" i]').some(
      (z) => RE_RESUME_FILE.test(z.textContent ?? "") && RE_DROPZONE.test(z.textContent ?? "") && isVisible(z),
    );
  if (resumeFile || dropzone) add(30, "résumé upload");

  const kinds = new Set<string>();
  for (const h of handles) {
    const m = NAME_EMAIL_PHONE.exec(h.desc.label);
    if (m) kinds.add(/mail/i.test(m[0]) ? "email" : /phone|mobile/i.test(m[0]) ? "phone" : "name");
    else if (h.desc.autocomplete && /name|email|tel/.test(h.desc.autocomplete)) kinds.add(h.desc.autocomplete);
    else if (LABEL_RULES.some(([re, k]) => re.test(h.desc.label) && (k === "email" || k === "phone")))
      kinds.add("contact");
  }
  if (kinds.size >= 2) add(15, "name/email/phone");

  const fillable = handles.filter((h) => h.desc.kind !== "file").length;
  if (fillable >= 6) add(10, "≥6 fields");

  const buttons = deepQueryAll("button,input[type=submit],a[role=button],a.button,[role=button]");
  if (buttons.some((b) => RE_SUBMIT_TEXT.test(collapse(b.textContent || (b as HTMLInputElement).value || ""))))
    add(10, "submit button");

  const password = deepQueryAll("input[type=password]").some(isVisible);
  if (password && fillable < 6) add(-50, "login/signup");

  const search = deepQueryAll("[role=search],input[type=search]").some(isVisible);
  if (search && fillable <= 1) add(-40, "search box only");

  return { score: Math.max(0, Math.min(100, score)), signals };
}
