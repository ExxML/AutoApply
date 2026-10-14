// §11.7 job context extraction.
import { isAtsHost } from "../shared/constants";
import { collapse } from "../shared/normalize";
import type { JobContext } from "../shared/types";
import { isVisible } from "./scan/visibility";

const RE_DESC = /responsibilit|qualification|requirement|about (the|this) (role|job|position)|what you('|’)ll do/gi;

const meta = (doc: Document, prop: string) =>
  doc.querySelector<HTMLMetaElement>(`meta[property="${prop}"],meta[name="${prop}"]`)?.content?.trim() ?? "";

function htmlToText(html: string): string {
  const d = new DOMParser().parseFromString(html, "text/html");
  return collapse(d.body?.textContent ?? "");
}

interface JobPosting {
  description?: string;
  title?: string;
  hiringOrganization?: { name?: string } | string;
}

function jsonLdJobPosting(doc: Document): JobPosting | null {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent ?? "");
      const stack = [data];
      while (stack.length) {
        const x = stack.pop();
        if (Array.isArray(x)) stack.push(...x);
        else if (x && typeof x === "object") {
          const t = x["@type"];
          if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return x as JobPosting;
          if (x["@graph"]) stack.push(x["@graph"]);
        }
      }
    } catch {
      // malformed JSON-LD is common; ignore it
    }
  }
  return null;
}

export function companyFromHost(loc: Location): string {
  const host = loc.hostname.replace(/^(www|careers|jobs|apply)\./, "");
  if (isAtsHost(loc.hostname, loc.pathname)) {
    const seg = loc.pathname.split("/").filter(Boolean)[0];
    if (seg && !/^(jobs?|apply|careers?|en|en-us|embed)$/i.test(seg)) return seg.replace(/[-_]+/g, " ");
    const sub = loc.hostname.split(".")[0];
    if (!/^(www|jobs|boards|job-boards|apply|careers)$/.test(sub)) return sub;
  }
  return host.split(".")[0];
}

function largestDescriptionBlock(doc: Document): string {
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const el of doc.querySelectorAll<HTMLElement>("main,article,section,div")) {
    const text = el.textContent ?? "";
    if (text.length <= bestLen || text.length < 200) continue;
    const hits = new Set((text.match(RE_DESC) ?? []).map((m) => m.toLowerCase().slice(0, 8)));
    if (hits.size >= 2 && isVisible(el)) {
      best = el;
      bestLen = text.length;
    }
  }
  return best ? collapse(best.innerText ?? best.textContent ?? "").slice(0, 8000) : "";
}

export function extractJobContext(doc: Document = document, loc: Location = location): JobContext {
  const ld = jsonLdJobPosting(doc);
  const h1 = collapse(doc.querySelector("h1")?.textContent ?? "");
  const org = ld?.hiringOrganization;
  return {
    url: loc.href,
    title: doc.title,
    jobTitle: h1 || meta(doc, "og:title") || doc.title,
    company: meta(doc, "og:site_name") || (typeof org === "string" ? org : (org?.name ?? "")) || companyFromHost(loc),
    text: ld?.description ? htmlToText(ld.description).slice(0, 8000) : largestDescriptionBlock(doc),
    capturedAt: Date.now(),
  };
}
