// Job sources: GitHub listing feeds and job boards. Parsed with regexes: a service worker has no DOMParser.
import { normalize } from "../../shared/normalize";
import type { Listing } from "../../shared/yolo";

/**
 * A link read from a page rendered in the hidden host; `card` is the text of the result card around it. A scrape gives
 * null instead when the page was a bot check (Cloudflare's "Just a moment…") rather than the page asked for.
 * `frame` marks an iframe's address rather than a link: an ATS board embedded in the page.
 */
export interface Link {
  href: string;
  text: string;
  card?: string;
  frame?: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITIES[e.toLowerCase()] ?? m),
  );
export const text = (html: string) =>
  decode(html.replace(/<\/?br\s*\/?>/gi, "; ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const enc = encodeURIComponent;

// ---------- GitHub feeds ----------
interface FeedRow {
  url?: string;
  company_name?: string;
  company?: string;
  title?: string;
  locations?: string[];
  location?: string;
  date_posted?: number;
  active?: boolean;
  is_visible?: boolean;
}

/** A Simplify-style listings.json, or a README whose tables hold Company | Role | Location | Apply link. */
export function parseFeed(body: string, source: string): Listing[] {
  const t = body.trimStart();
  if (!t.startsWith("[") && !t.startsWith("{")) return parseTables(t, source);
  const data = JSON.parse(t) as FeedRow[] | { listings?: FeedRow[] };
  return (Array.isArray(data) ? data : (data.listings ?? [])).flatMap((r) =>
    r?.url && r.title && r.active !== false && r.is_visible !== false
      ? [
          {
            url: r.url,
            company: r.company_name ?? r.company ?? "",
            title: r.title,
            location: r.locations?.join("; ") ?? r.location ?? "",
            postedAt: r.date_posted ? r.date_posted * 1000 : undefined,
            source,
          },
        ]
      : [],
  );
}

/** "↳" repeats the company of the row above; 🔒 marks a closed posting. */
function parseTables(md: string, source: string): Listing[] {
  const rows = [...md.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]),
  );
  for (const line of md.split("\n"))
    if (/^\s*\|/.test(line) && !/^\s*\|\s*:?-/.test(line))
      rows.push(
        line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|"),
      );
  const out: Listing[] = [];
  let company = "";
  for (const cells of rows) {
    if (cells.length < 4) continue;
    // Before the closed check: a closed row can name the company its "↳" rows below repeat.
    const name = cellText(cells[0]);
    company = name === "↳" ? company : name;
    if (cells.join("").includes("🔒")) continue;
    const url = cells
      .slice(3)
      .join(" ")
      .match(/https?:\/\/[^\s)"'<>]+/g)
      ?.find((u) => !/simplify\.jobs|github\.com|githubusercontent|imgur|shields\.io/.test(u));
    if (url && company)
      out.push({ url: decode(url), company, title: cellText(cells[1]), location: cellText(cells[2]), source });
  }
  return out;
}
const cellText = (s: string) => text(s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")).replace(/\*\*/g, "");

// ---------- job boards ----------
/** LinkedIn's logged-out search: fetched without cookies, so the user's account is never involved. */
export const linkedinSearch = (q: string, loc: string, days: number, start = 0) =>
  `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${enc(q)}&location=${enc(loc)}&f_TPR=r${days * 86400}&start=${start}`;

/** The same search on LinkedIn's own page, for the user to open: the guest API above answers bare HTML cards. */
export const linkedinPage = (q: string, loc: string, days: number) =>
  `https://www.linkedin.com/jobs/search/?keywords=${enc(q)}&location=${enc(loc)}&f_TPR=r${days * 86400}`;
/** The page Jobright's recommendation feed (`jobrightFeed`) backs. */
export const JOBRIGHT_PAGE = "https://jobright.ai/jobs/recommend";

export function parseLinkedIn(html: string): Listing[] {
  return html
    .split('data-entity-urn="urn:li:jobPosting:')
    .slice(1)
    .flatMap((c) => {
      const id = /^\d+/.exec(c)?.[0];
      const pick = (re: RegExp) => text(re.exec(c)?.[1] ?? "");
      const date = /datetime="(\d{4}-\d\d-\d\d)"/.exec(c)?.[1];
      const title = pick(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
      return id && title
        ? [
            {
              url: `https://www.linkedin.com/jobs/view/${id}`,
              title,
              company: pick(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
              location: pick(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
              postedAt: date ? Date.parse(date) : undefined,
              source: "linkedin",
            },
          ]
        : [];
    });
}

const countryOf = (loc: string) => loc.split(",").pop()?.trim().toLowerCase() ?? "";
const GLASSDOOR_HOSTS: Record<string, string> = {
  canada: "www.glassdoor.ca",
  "united kingdom": "www.glassdoor.co.uk",
  uk: "www.glassdoor.co.uk",
  india: "www.glassdoor.co.in",
  australia: "www.glassdoor.com.au",
  germany: "www.glassdoor.de",
};

/**
 * The search's own page on the country's Glassdoor: `jobs.htm?sc.keyword=…` redirects there and drops `fromAge`, and
 * another country's site redirects too. Glassdoor ignores the place in either URL (it searches the visitor's country;
 * live, 2026-11-03), so the location filter does that part.
 */
export const glassdoorSearch = (q: string, loc: string, days: number) => {
  const { host, kw, age } = glassdoorParts(q, loc, days);
  return `https://${host}/Job/${kw}-jobs-SRCH_KO0,${kw.length}.htm?fromAge=${age}`;
};
const glassdoorParts = (q: string, loc: string, days: number) => ({
  host: GLASSDOOR_HOSTS[countryOf(loc)] ?? "www.glassdoor.com",
  kw: normalize(q)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, ""),
  age: Math.min(days, 30),
});

/**
 * The search's page `page` (from 2) as its "Show more jobs" button asks for it, at the cursor an earlier page gave
 * (`parseGlassdoor`): the search page itself always shows page 1, whatever page its URL names (live, 2026-11-08).
 */
export function glassdoorMore(q: string, loc: string, days: number, page: number, cursor: string) {
  const { host, kw, age } = glassdoorParts(q, loc, days);
  return {
    url: `https://${host}/job-search-next/bff/jobSearchResultsQuery`,
    init: {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      // As the page sends it.
      body: JSON.stringify({
        excludeJobListingIds: [],
        filterParams: [{ filterKey: "fromAge", values: String(age) }],
        includeIndeedJobAttributes: true,
        keyword: kw.replace(/-/g, " "),
        locationId: 0,
        numJobsToShow: 30,
        originalPageUrl: glassdoorSearch(q, loc, days),
        pageCursor: cursor,
        pageNumber: page,
        pageType: "SERP",
        parameterUrlInput: `KO0,${kw.length}`,
        queryString: `fromAge=${age}`,
        seoFriendlyUrlInput: `${kw}-jobs`,
        seoUrl: true,
      }),
    } satisfies RequestInit,
  };
}

interface GlassdoorResults {
  jobListings?: {
    jobview?: {
      header?: {
        jobTitleText?: string;
        /** The posting's page, `?jl=<listingId>`. */
        seoJobLink?: string;
        employer?: { shortName?: string };
        employerNameFromSearch?: string;
        locationName?: string;
        /** 0 = within the last day ("24h"). */
        ageInDays?: number;
        easyApply?: boolean;
        expired?: boolean;
      };
      job?: { listingId?: number };
    };
  }[];
  /** Cursors to the pages around this one, by page number (from 1). */
  paginationCursors?: { cursor?: string; pageNumber?: number }[];
}

/**
 * Page `page` (from 1) of a Glassdoor search: its postings, and the cursor to the next page (none = the last). Read from
 * the results object page 1 carries in its Next.js payload, or `glassdoorMore`'s JSON answer for the later pages: the
 * same object either way. [] = no results (none, or a bot check stood in for the page).
 */
export function parseGlassdoor(body: string, page = 1, now = Date.now()): { jobs: Listing[]; next?: string } {
  let r: GlassdoorResults | null = null;
  if (body.trimStart().startsWith("{")) {
    try {
      r = (JSON.parse(body) as { data?: { jobListings?: GlassdoorResults } }).data?.jobListings ?? null;
    } catch {
      // Not JSON after all: no results.
    }
  } else {
    const rsc = nextPayload(body);
    const at = rsc.indexOf('"jobListings":{');
    r = at < 0 ? null : (objectAt(rsc, at + 14) as GlassdoorResults | null);
  }
  const seen = new Set<string>();
  const jobs = (Array.isArray(r?.jobListings) ? r.jobListings : []).flatMap(({ jobview: v } = {}) => {
    const h = v?.header;
    const id = String(v?.job?.listingId ?? "");
    if (!h?.jobTitleText || !h.seoJobLink || !id || h.expired || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        // Glassdoor answers Canadian visitors in French at times; YOLO reads English pages.
        url: h.seoJobLink.replace(/:\/\/[a-z]{2}\.glassdoor\./, "://www.glassdoor."),
        title: h.jobTitleText,
        // The name its card shows.
        company: h.employer?.shortName || h.employerNameFromSearch || "",
        location: h.locationName ?? "",
        postedAt: typeof h.ageInDays === "number" ? now - h.ageInDays * 86400e3 : undefined,
        source: "glassdoor",
        easyApply: h.easyApply || undefined,
      },
    ];
  });
  return { jobs, next: r?.paginationCursors?.find((c) => c.pageNumber === page + 1)?.cursor || undefined };
}

const INDEED_HOSTS: Record<string, string> = {
  canada: "ca.indeed.com",
  "united kingdom": "uk.indeed.com",
  uk: "uk.indeed.com",
  india: "in.indeed.com",
  australia: "au.indeed.com",
  germany: "de.indeed.com",
};
const indeedHost = (loc: string) => INDEED_HOSTS[countryOf(loc)] ?? "www.indeed.com";

/**
 * Indeed's search, read as the signed-in user (their cookies): fetched by the worker, or rendered in a background tab
 * when Cloudflare checks the fetch. Either way the page carries its result cards as JSON (`parseIndeed`). `page` (from 0)
 * steps `start` by 10, as Indeed's own page links do (15 cards a page; live, 2026-11-08).
 */
export const indeedSearch = (q: string, loc: string, days: number, page = 0) =>
  `https://${indeedHost(loc)}/jobs?q=${enc(q)}&l=${enc(loc)}&fromage=${[1, 3, 7, 14].find((d) => d >= days) ?? 14}&sort=date${page ? `&start=${page * 10}` : ""}`;

/**
 * Indeed's account page, asked with HEAD (headers only): signed out, it redirects to sign-in at /auth; signed in, it
 * answers 200 where it is (live, 2026-11-04). The sign-in is Indeed-wide, so it covers every country's search.
 */
export const INDEED_ACCOUNT = "https://secure.indeed.com/settings/account";
/** Whether the INDEED_ACCOUNT probe, at the URL it ended on, landed on Indeed's sign-in page. */
export const indeedSignedOut = (finalUrl: string) =>
  /^https:\/\/secure\.indeed\.com\/(auth|account\/login)\b/.test(finalUrl);

const INDEED_CARDS = /window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*/;
/** A bot check standing in for the search: Cloudflare's interstitial or block page (titles as in botWall). */
const INDEED_WALL =
  /<title[^>]*>\s*(just a moment|security check|attention required|blocked|access denied)\b|\bRay ID\b/i;

/**
 * The JSON object or array starting at `at` in `s`, its brackets matched outside strings; null if there's none or it
 * won't parse.
 */
function objectAt(s: string, at: number): unknown {
  if (s[at] !== "{" && s[at] !== "[") return null;
  let depth = 0;
  let str = false;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (c === "\\") i++;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) {
      try {
        return JSON.parse(s.slice(at, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The Next.js payload a page streams in `self.__next_f.push([1,"…"])` scripts, as one string. */
const nextPayload = (html: string) =>
  [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]) as string;
      } catch {
        return "";
      }
    })
    .join("");

interface IndeedCard {
  jobkey?: string;
  displayTitle?: string;
  title?: string;
  company?: string;
  truncatedCompany?: string;
  formattedLocation?: string;
  remoteLocation?: boolean;
  /** Epoch ms. */
  pubDate?: number;
  indeedApplyEnabled?: boolean;
  indeedApplyable?: boolean;
  expired?: boolean;
}

/**
 * A search page's result cards, from the job-card data Indeed embeds in it (a fetched page, or that script's text from
 * a rendered one). null = a bot check stood in for the page; [] = no cards.
 */
export function parseIndeed(page: string, host: string): Listing[] | null {
  const m = INDEED_CARDS.exec(page);
  const data = m
    ? (objectAt(page, m.index + m[0].length) as {
        metaData?: { mosaicProviderJobCardsModel?: { results?: IndeedCard[] } };
      } | null)
    : null;
  const cards = data?.metaData?.mosaicProviderJobCardsModel?.results;
  if (!Array.isArray(cards)) {
    if (INDEED_WALL.test(page)) return null;
    if (page) console.warn("[AutoApply] Indeed: the search page had no job-card data");
    return [];
  }
  const seen = new Set<string>();
  return cards.flatMap((c) => {
    const jk = c?.jobkey;
    const title = decode(c?.displayTitle || c?.title || "");
    if (!jk || !/^[0-9a-f]+$/i.test(jk) || !title || c.expired || seen.has(jk)) return [];
    seen.add(jk);
    const place = decode(c.formattedLocation ?? "");
    return [
      {
        url: `https://${host}/viewjob?jk=${jk}`,
        title,
        company: decode(c.company || c.truncatedCompany || ""),
        location: c.remoteLocation && !/\bremote\b/i.test(place) ? (place ? `Remote - ${place}` : "Remote") : place,
        // Epoch ms; anything smaller isn't a date in this century, so it's left out rather than read as 1970.
        postedAt: typeof c.pubDate === "number" && c.pubDate > 1e12 ? c.pubDate : undefined,
        source: "indeed",
        // Applied to on Indeed itself (Indeed Apply): not supported yet, so never queued.
        easyApply: c.indeedApplyEnabled || c.indeedApplyable || undefined,
      },
    ];
  });
}

/**
 * Run in Indeed's search page in a tab (chrome.scripting sends it as source, so it is self-contained): the job-card
 * script's text, "" once the page has loaded without one, or null while a bot check stands in for it.
 */
export function indeedCardsInPage(): string | null {
  // The data is assigned in <script id="mosaic-data">; an earlier, smaller script names the same provider without it
  // (live, signed in, 2026-11-04).
  const s = Array.from(document.scripts).find((x) => /\["mosaic-provider-jobcards"\]\s*=/.test(x.text));
  if (s) return s.text;
  const wall =
    /^(just a moment|security check|attention required|blocked|access denied)\b/i.test(document.title) ||
    /\bRay ID\b/.test(document.body?.textContent ?? "") ||
    !!document.querySelector('iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"]');
  return document.readyState === "complete" && !wall ? "" : null;
}
export { indeedHost };

// ---------- ZipRecruiter ----------
/**
 * One site for every country: ziprecruiter.ca redirects here, and Toronto searches find Toronto jobs (live, 2026-11-07).
 * `page` (from 0) is the path's page number from 2 on, as its own page links have it (live, 2026-11-08).
 */
export const zipRecruiterSearch = (q: string, loc: string, days: number, page = 0) =>
  `https://www.ziprecruiter.com/jobs-search${page ? `/${page + 1}` : ""}?search=${enc(q)}&location=${enc(loc)}&days=${days}`;

interface ZipCard {
  title?: string;
  /** Its own posting page, site-relative: "/c/PayPal/Job/…?jid=…". */
  rawCanonicalZipJobPageUrl?: string;
  company?: { name?: string };
  location?: { displayName?: string };
  /** `locationTypes` "On-site", "Remote" or "Hybrid". */
  display?: { location?: string; locationTypes?: string };
  /** Seconds as the page's "$n<digits>" bigint. */
  status?: { isActive?: boolean; postedAtUtc?: { seconds?: string | number } };
  /** 3 = "Quick Apply" on ZipRecruiter; 4 = "Apply", a /job-redirect link to the employer's site (live, 2026-11-07). */
  applyButtonConfig?: { applyButtonType?: number };
}

/**
 * A search page's result cards (20 at most), from the Next.js payload it streams: its `jobCards`. [] = no cards (none,
 * past the last page, or a bot check stood in for the page).
 */
export function parseZipRecruiter(html: string): Listing[] {
  const rsc = nextPayload(html);
  const at = rsc.indexOf('"jobCards":[');
  const cards = at < 0 ? null : objectAt(rsc, at + 11);
  if (!Array.isArray(cards)) return [];
  const seen = new Set<string>();
  return (cards as ZipCard[]).flatMap((c) => {
    const path = c?.rawCanonicalZipJobPageUrl;
    if (!c?.title || !path?.startsWith("/") || c.status?.isActive === false || seen.has(path)) return [];
    seen.add(path);
    const place = c.display?.location || c.location?.displayName || "";
    const secs = Number(String(c.status?.postedAtUtc?.seconds ?? "").replace(/^\$n/, ""));
    return [
      {
        url: `https://www.ziprecruiter.com${path}`,
        title: c.title,
        company: c.company?.name ?? "",
        location:
          /\bremote\b/i.test(c.display?.locationTypes ?? "") && !/\bremote\b/i.test(place)
            ? place
              ? `Remote - ${place}`
              : "Remote"
            : place,
        postedAt: secs > 1e9 ? secs * 1000 : undefined,
        source: "ziprecruiter",
        // Applied to on ZipRecruiter itself: not supported yet, so never queued.
        easyApply: c.applyButtonConfig?.applyButtonType === 3 || undefined,
      },
    ];
  });
}

// ---------- Jobright ----------
/**
 * The signed-in user's Jobright recommendations (jobright.ai/jobs/recommend, filtered by their Jobright preferences):
 * a cursor, so page 0 starts a fresh list and later pages continue it until one comes back empty. Signed out = 401.
 */
export const jobrightFeed = (page: number) =>
  `https://jobright.ai/swan/recommend/list/jobs?refresh=${page === 0}&sortCondition=0&position=${page * 20}&count=20&syncRerank=false`;

/** A tiny signed-in-only endpoint (65 B): 200 when signed in, 401 "Cookie not found" when not (live, 2026-11-03). */
export const JOBRIGHT_PING = "https://jobright.ai/swan/msg/has-unread";

interface JobrightJob {
  jobResult?: {
    jobTitle?: string;
    jobLocation?: string;
    jobLocations?: string[];
    workModel?: string;
    isRemote?: boolean;
    publishTime?: string;
    applyLink?: string;
    isDeleted?: boolean;
  };
  companyResult?: { companyName?: string };
}

/** A feed page's jobList, read as postings on the employer's own site (Jobright gives that link to signed-in users). */
export function parseJobrightFeed(list: JobrightJob[]): Listing[] {
  return list.flatMap(({ jobResult: j, companyResult: c }) => {
    let host: string;
    try {
      host = new URL(j?.applyLink ?? "").hostname;
    } catch {
      return [];
    }
    // LinkedIn shows logged-out visitors no way to the employer; Jobright's own links loop back to it.
    if (!j?.jobTitle || j.isDeleted || /(^|\.)(jobright\.ai|linkedin\.com)$/.test(host)) return [];
    const remote = j.isRemote || /^remote$/i.test(j.workModel ?? "");
    const places = j.jobLocations?.length ? j.jobLocations : [j.jobLocation ?? ""];
    // publishTime is UTC: "2026-11-03 16:59:05".
    const at = Date.parse(`${(j.publishTime ?? "").replace(" ", "T")}Z`);
    return [
      {
        url: j.applyLink!,
        title: j.jobTitle,
        company: c?.companyName ?? "",
        location: places.map((p) => (remote && !/\bremote\b/i.test(p) ? `Remote - ${p}` : p)).join("; "),
        postedAt: Number.isFinite(at) ? at : undefined,
        source: "jobright",
      },
    ];
  });
}
