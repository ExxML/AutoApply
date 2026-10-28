// §11.7 job context extraction.
import { canonicalCountry, HUBS, isAtsHost, regionCountry } from "../shared/constants";
import { collapse, normalize } from "../shared/normalize";
import type { JobContext, Pay } from "../shared/types";
import { isVisible } from "./scan/visibility";

// MongoDB: "What we are looking for in you (qualifications)".
const RE_DESC =
  /responsibilit|qualification|requirement|about (the|this) (role|job|position)|what you('|’)ll do|what we('|’)re looking for|what we are looking for|who you are/gi;

const descHits = (text: string) => new Set((text.match(RE_DESC) ?? []).map((m) => m.toLowerCase().slice(0, 8))).size;

const meta = (doc: Document, prop: string) =>
  doc.querySelector<HTMLMetaElement>(`meta[property="${prop}"],meta[name="${prop}"]`)?.content?.trim() ?? "";

function htmlToText(html: string): string {
  const text = new DOMParser().parseFromString(html, "text/html").body?.textContent ?? "";
  // Brex's JSON-LD escapes its HTML twice ("&lt;div class=&quot;…"): one pass leaves markup behind.
  return /<\/?[a-z][^>]*>/i.test(text) && text !== html ? htmlToText(text) : collapse(text);
}

type Named = string | { name?: string } | null | undefined;
interface PostalAddress {
  addressLocality?: string | null;
  addressRegion?: string | null;
  addressCountry?: Named;
}

interface MonetaryAmount {
  currency?: string;
  value?:
    | number
    | string
    | { value?: number | string; minValue?: number | string; maxValue?: number | string; unitText?: string };
}

interface JobPosting {
  description?: string;
  baseSalary?: MonetaryAmount | MonetaryAmount[];
  title?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: { address?: string | PostalAddress } | { address?: string | PostalAddress }[];
  jobLocationType?: string;
  applicantLocationRequirements?: Named | Named[];
}

const nameOf = (n: Named) => (typeof n === "string" ? n : (n?.name ?? ""));

/** "Dublin, Ireland; Remote (USA)": every place the posting names. */
function ldLocation(ld: JobPosting): string {
  const places = [ld.jobLocation ?? []]
    .flat()
    .map(({ address: a }) =>
      typeof a === "string"
        ? a
        : [a?.addressLocality, a?.addressRegion, nameOf(a?.addressCountry)].filter(Boolean).join(", "),
    );
  if (ld.jobLocationType === "TELECOMMUTE") {
    const where = [ld.applicantLocationRequirements ?? []].flat().map(nameOf).filter(Boolean).join(", ");
    places.push(where ? `Remote (${where})` : "Remote");
  }
  return collapse([...new Set(places.filter(Boolean))].join("; ")).slice(0, 300);
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

const MARKED_DESC =
  '[class*="description" i],[id*="description" i],[data-qa*="description" i],[data-automation-id*="description" i],[itemprop=description]';

/**
 * The block the page itself names as the description (Greenhouse's .job__description), for a posting without two
 * of the usual headings: a short intern posting ("Acme is hiring… The pay is $45 - $55 per hour.") went unread, pay
 * and all. Not a form's question descriptions.
 */
function markedDescription(doc: Document): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLen = 199;
  for (const el of doc.querySelectorAll<HTMLElement>(MARKED_DESC)) {
    const len = (el.textContent ?? "").length;
    if (len > bestLen && !el.closest("form") && !el.querySelector(CONTROLS) && isVisible(el)) {
      best = el;
      bestLen = len;
    }
  }
  return best;
}

function largestDescriptionBlock(doc: Document): string {
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const el of doc.querySelectorAll<HTMLElement>("main,article,section,div")) {
    const text = el.textContent ?? "";
    if (text.length <= bestLen || text.length < 200) continue;
    if (descHits(text) >= 2 && isVisible(el)) {
      best = el;
      bestLen = text.length;
    }
  }
  best ??= markedDescription(doc);
  return best ? collapse(best.innerText ?? best.textContent ?? "").slice(0, 8000) : "";
}

/** Visible text before the first form control (title, location, team on apply pages). */
function headerText(doc: Document): string {
  const first = doc.querySelector("input:not([type=hidden]),select,textarea");
  const parts: string[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && parts.join(" ").length < 1000; n = walker.nextNode()) {
    if (first && first.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    const p = n.parentElement;
    if (!p || p.closest("script,style,noscript,template") || !isVisible(p)) continue;
    const t = n.textContent?.trim();
    if (t) parts.push(t);
  }
  return collapse(parts.join(" ")).slice(0, 1000);
}

/** A short visible location label outside forms and site chrome (Greenhouse's .job__location, Lever's .location). */
function locationText(doc: Document): string {
  for (const el of doc.querySelectorAll<HTMLElement>('[class*="location" i]')) {
    if (el.closest("form,header,footer,nav") || el.querySelector("input,select,textarea") || !isVisible(el)) continue;
    const t = collapse(el.textContent ?? "");
    if (t.length >= 2 && t.length <= 100) return t;
  }
  return "";
}

/**
 * A place among the few short texts right under the title, ending in a country or region, or a tech hub: company
 * pages that embed the application ("New York, NY, United States" on Ripple, "Ontario, Canada" on Fivetran, "Sydney,
 * Australia" on Riot). The title may be an h2 (Datadog) and hold the place in a nested heading (MongoDB's "New York
 * City").
 */
function underTitle(doc: Document): string {
  const title = doc.querySelector("h1") ?? doc.querySelector("main h2");
  if (!title) return "";
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = title;
  let seen = 0;
  for (let n = walker.nextNode(); n && seen < 4; n = walker.nextNode()) {
    const t = collapse(n.textContent ?? "");
    if (!t || (title.contains(n) && n.parentElement?.closest("h1,h2,h3,h4,h5,h6") === title)) continue;
    seen++;
    const last = t.split(",").pop()!;
    if (t.length <= 60 && (canonicalCountry(last) || regionCountry(last) || HUBS[normalize(t)])) return t;
  }
  return "";
}

export function extractJobContext(doc: Document = document, loc: Location = location): JobContext {
  const ld = jsonLdJobPosting(doc);
  const h1 = collapse(doc.querySelector("h1")?.textContent ?? "");
  const org = ld?.hiringOrganization;
  const text = ld?.description ? htmlToText(ld.description).slice(0, 8000) : largestDescriptionBlock(doc);
  const where = (ld && ldLocation(ld)) || locationText(doc) || underTitle(doc);
  return {
    url: loc.href,
    title: doc.title,
    jobTitle: h1 || meta(doc, "og:title") || doc.title,
    company: meta(doc, "og:site_name") || (typeof org === "string" ? org : (org?.name ?? "")) || companyFromHost(loc),
    text,
    ...(text ? {} : { header: headerText(doc) }),
    ...(where ? { location: where } : {}),
    capturedAt: Date.now(),
  };
}

// ---------- Pay ranges ----------

/** A range in the units the answer uses (monthly pay as yearly), or null when it can't be someone's base pay. */
function toPay(min: number, max: number, unit: string, currency: string): Pay | null {
  const period = /^h/i.test(unit) ? "hour" : /^(y|a)/i.test(unit) ? "year" : /^mo/i.test(unit) ? "month" : "";
  const k = period === "month" ? 12 : 1;
  const p = { min: min * k, max: max * k, period: period === "hour" ? "hour" : "year", currency } as const;
  if (!period || !(p.min > 0) || p.min > p.max) return null;
  return (p.period === "hour" ? p.max <= 1000 && p.min >= 5 : p.max <= 2e6 && p.min >= 1e4) ? p : null;
}

function ldPay(ld: JobPosting): Pay[] {
  return [ld.baseSalary ?? []].flat().flatMap((m) => {
    const v = typeof m.value === "object" ? m.value : { value: m.value };
    const min = Number(v.minValue ?? v.value);
    const p = toPay(min, Number(v.maxValue ?? min), v.unitText ?? "", m.currency?.toUpperCase() ?? "");
    return p ? [p] : [];
  });
}

const SYMBOLS: Record<string, string> = {
  US$: "USD",
  CA$: "CAD",
  C$: "CAD",
  A$: "AUD",
  AU$: "AUD",
  "£": "GBP",
  "€": "EUR",
};
const CODE = "(USD|CAD|AUD|GBP|EUR)";
// [code] [symbol] number[.cents] [k] [code]; "$5M" and "$2 billion" are funding, not pay. No \b after the last code:
// textContent runs blocks together ("$190,000 USDAt Figma").
const AMOUNT = String.raw`(?:${CODE}\s?)?(US\$|CA\$|C\$|AU?\$|\$|£|€)?\s?(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?\s?([kK]\b)?(?!\s?(?:[mMbB]\b|million|billion))(?:\s?${CODE})?`;
const RE_AMOUNTS = new RegExp(String.raw`${AMOUNT}(?:\s*(?:-|–|—|to|and)\s*${AMOUNT})?`, "g");
const RE_PAY_WORD =
  /\b(salary|pay|compensation|wages?|rate|range|earn|base|hour|hr|hourly|year|yr|annual|annum|month)\b/i;
const RE_NOT_PAY =
  /\b(bonus|equity|stipend|budget|allowance|reimburs\w*|referral|relocation|housing|wellness|learning|revenue|raised|funding|valuation|sign-?on|signing|401)\b/i;

/** Every pay range or rate the text states ("$120,000 – $150,000 USD", "$45/hr", "CA$80K to CA$100K"). */
export function payIn(text: string): Pay[] {
  const out: Pay[] = [];
  for (const m of text.matchAll(RE_AMOUNTS)) {
    const [, c1, s1, n1, d1, k1, a1, c2, s2, n2, d2, k2, a2] = m;
    const symbol = s1 ?? s2;
    const code = c1 ?? a1 ?? c2 ?? a2;
    if (!symbol && !code) continue;
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    // "+ bonus + equity" after a salary adds to it; "signing bonus" right after an amount names what it is.
    const next = after.split(/[+&,;.(]|\b(?:plus|and|with)\b/)[0];
    if (!RE_PAY_WORD.test(before + after) || RE_NOT_PAY.test(before.slice(-25) + " " + next)) continue;
    const num = (n: string, d = "") => Number(n.replace(/\D/g, "") + "." + d);
    let [lo, hi] = [num(n1, d1), n2 ? num(n2, d2) : num(n1, d1)];
    // "$120-150K": the k belongs to both.
    if (k1 || (k2 && lo < 1000)) lo *= 1000;
    if (k2 || (k1 && !n2)) hi *= 1000;
    const unit =
      after.match(/^[\s(]{0,2}(?:per |an? |\/\s?)?(hour|hr|h\b|year|yr|annum|annual|month|mo\b)/i)?.[1] ??
      before.match(/\b(hourly|annual|yearly|monthly)\b[^$€£\d]*$/i)?.[1] ??
      (hi <= 500 ? "hour" : lo >= 1e4 ? "year" : "");
    const p = toPay(lo, hi, unit, code ?? SYMBOLS[symbol!] ?? "");
    if (p) out.push(p);
  }
  return out;
}

const RE_JOB_URL = /job|career|position|opening|vacanc|requisition|posting|recruit|hiring/i;
/** An address that may show a job posting: an ATS, or a URL that says so. */
export const jobUrl = (loc: Location) => isAtsHost(loc.hostname, loc.pathname) || RE_JOB_URL.test(loc.href);
const CONTROLS = "input:not([type=hidden]),select,textarea";
const SKIP_TEXT = "script,style,noscript,template,form,label,fieldset,select,textarea,button,[role=dialog],nav,footer";

/**
 * The text of the posting shown: the smallest element holding every short description heading ("Responsibilities",
 * "Qualifications"), so a job board's other cards and an application form's example answers stay out. Up to two
 * levels above it without a form control: Greenhouse keeps the pay ranges beside the description, not in it.
 * `sure`: two kinds of heading; one ("Qualifications" on Faire) may be a stray word on a page without a posting.
 * shortcut: one stray heading elsewhere (a footer's "Requirements") widens it to the page; scoring blocks would fix it.
 */
function postingText(doc: Document): { text: string; sure: boolean } {
  const hits: Element[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? "";
    RE_DESC.lastIndex = 0;
    if (t.length > 120 || !RE_DESC.test(t)) continue;
    const p = n.parentElement;
    if (p && !p.closest(SKIP_TEXT)) hits.push(p);
  }
  const marked = hits.length ? null : markedDescription(doc);
  if (!hits.length && !marked) return { text: "", sure: false };
  let root: Element | null = marked ?? hits[0];
  while (root && !hits.every((h) => root!.contains(h))) root = root.parentElement;
  for (let i = 0; i < 2 && root?.parentElement && !root.parentElement.querySelector(CONTROLS); i++)
    root = root.parentElement;
  return { text: collapse(root?.textContent ?? ""), sure: descHits(hits.map((h) => h.textContent).join(" ")) >= 2 };
}

/**
 * The pay ranges of the job posting on the page, or null when the page shows no posting. One pass over the text, so
 * it can run on every job page load: an application's later pages no longer show the posting's pay.
 */
export function readPay(doc: Document = document, loc: Location = location): Pay[] | null {
  const ld = jsonLdJobPosting(doc);
  if (ld) {
    const pays = ldPay(ld);
    return pays.length ? pays : payIn(htmlToText(ld.description ?? ""));
  }
  if (!jobUrl(loc)) return null;
  const { text, sure } = postingText(doc);
  const pays = payIn(text);
  return pays.length || sure ? pays : null;
}
