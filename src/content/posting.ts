// What job a page shows: whether it is one posting, and the posting the AI is given for it, in manual fills and YOLO.
import type { Responses } from "../shared/messages";
import { collapse } from "../shared/normalize";
import type { JobContext } from "../shared/types";
import { extractJobContext, jobUrl, jsonLdJobPosting, postingFacts, shownText } from "./jobContextExtract";
import { deepQueryAll } from "./scan/traverse";
import { isVisible } from "./scan/visibility";
import { embeddedForm } from "./yolo/classify";
import { applyInfo, findApply, oneApply } from "./yolo/nav";

/** Job addresses jobUrl leaves out: UKG's "OpportunityDetail", French and German careers sites, Dutch "vacature". */
const RE_MORE_JOB_URL = /opportunit|emploi|carri[eè]re|karriere|stelle|vacature/i;
export const jobAddress = (u: Location | URL) => jobUrl(u as Location) || RE_MORE_JOB_URL.test(u.href);

/**
 * An Apply link into this posting's own application: under its address ("…/apply"), carrying its id ("?pid=…"), or
 * at a job address (an employer's page sending to its ATS). A job list's lone Apply led elsewhere: Airbnb's to a
 * contractor talent community, Y Combinator's to its own startup application.
 */
function ownApplication(href: string): boolean {
  const u = new URL(href, location.href);
  const page = `${location.origin}${location.pathname.replace(/\/$/, "")}/`;
  const ids = `${location.pathname} ${location.search}`.match(/[\w-]*\d[\w-]*/g)?.filter((id) => id.length >= 5) ?? [];
  return `${u.origin}${u.pathname}`.startsWith(page) || ids.some((id) => u.href.includes(id)) || jobAddress(u);
}

/**
 * One job's posting: its JSON-LD names it, or, at a job address, its own way into its application (the Apply a YOLO
 * run would press, its controls all leading one place). Not a job list, an article, or a credit card's "Apply now".
 */
function postingPage(): boolean {
  const ld = postingFacts(document);
  if (ld.company && ld.title) return true;
  if (!jobAddress(location)) return false;
  const el = findApply();
  const apply = applyInfo(el).kind;
  const href = el?.closest("a[href]")?.getAttribute("href");
  return (apply === "entry" || (apply === "link" && !!href && ownApplication(href))) && oneApply();
}

/** Page chrome around a posting: menus, footers, cookie banners (Airbnb's led its page text). */
const CHROME =
  'nav,footer,[role=dialog],[aria-modal=true],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]';

/** A posting's page as shown, less its chrome and what's hidden from people (instructions planted for AI). */
function postingText(): string {
  const root = document.querySelector<HTMLElement>("main") ?? document.body;
  let text = shownText(root);
  for (const el of root.querySelectorAll<HTMLElement>(CHROME)) {
    const t = collapse(el.innerText ?? "");
    // Never a wrapper holding the posting itself (a page-wide "cookie-banner-shown" class).
    if (t.length >= 8 && t.length < text.length / 2 && !el.querySelector("h1")) text = text.replace(t, " ");
  }
  return collapse(text);
}

/**
 * The page's job as extractJobContext reads it; for a posting with no description it can find (UKG's has none of the
 * usual headings), the page as shown instead.
 */
export function jobContext(): JobContext {
  const c = extractJobContext();
  if (c.text || !postingPage()) return c;
  return { ...c, text: postingText(), header: undefined };
}

/**
 * The posting this page shows, for its application's pages (the tab's own next pages, or a tab it opens): any page
 * about a job, by its address or its JSON-LD (a posting at "acme.com/team/123"). Null on any other page.
 */
export function postingContext(): JobContext | null {
  if (!jobAddress(location) && !jsonLdJobPosting(document)) return null;
  const c = jobContext();
  return c.text ? c : null;
}

/**
 * The job a tab shows, for YOLO to apply to it there (popup "YOLO apply to job tabs"): a posting, or at a job address
 * its application itself (a résumé upload, an embedded ATS form). Null on any other page.
 */
export function tabJob(): Responses["READ_JOB_TAB"] {
  const posting = postingPage();
  if (!posting && !(jobAddress(location) && (document.querySelector('input[type="file"]') || embeddedForm())))
    return null;
  const ld = postingFacts(document);
  const meta = (p: string) => document.querySelector<HTMLMetaElement>(`meta[property="${p}"]`)?.content ?? "";
  const text = (s: string) => collapse(s).slice(0, 200);
  // The heading shown: SmartRecruiters' first <h1> is a hidden "Sorry, Internet Explorer 11 is no longer supported".
  const h1 = (deepQueryAll("h1").find(isVisible) as HTMLElement | undefined)?.innerText ?? "";
  const title = ld.title || text(h1) || text(meta("og:title")) || text(document.title);
  const c = jobContext();
  // Named by the page, else a guess from its address ("recruiting" for UKG's recruiting.ultipro.ca): for the
  // Applications list only, never for the application.
  const named = ld.company || text(meta("og:site_name"));
  const context = { ...c, company: named, jobTitle: title };
  return { ...ld, company: named || text(c.company), title, ...(!named && { companyGuessed: true }), context };
}

/**
 * The user pressing a posting's Apply: its posting goes to the background first, for the application's pages, which
 * often show none (Workday's, Lever's /apply). A new tab borrows it already (BORROW_POSTING); this tab didn't have it.
 * One message per press, none per page load.
 */
export function shareOnApply(e: Event, send: (ctx: JobContext) => void) {
  if (!e.isTrusted) return;
  const apply = findApply();
  // Its path, not its target: UKG's Apply is a <ukg-button>, its button inside a shadow root.
  if (!apply || !e.composedPath().includes(apply)) return;
  const ctx = postingContext();
  if (ctx) send(ctx);
}
