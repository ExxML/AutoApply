// One key per posting, whichever board or link it was found through, so a job is never applied to twice.
import { normalize } from "../../shared/normalize";

const parse = (raw: string) => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** Query parameters that name the posting; every other one (utm_*, ref, source…) is tracking. */
const ID_PARAMS = ["gh_jid", "jk", "jobid", "job", "id", "req", "requisitionid", "token", "for", "pid"];

export function jobKey(raw: string): string {
  const u = parse(raw);
  if (!u) return raw.trim().toLowerCase();
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const q = (k: string) => [...u.searchParams].find(([p]) => p.toLowerCase() === k)?.[1];
  const after = (s: string) => (seg.includes(s) ? seg[seg.indexOf(s) + 1] : undefined);
  const tenant = host.split(".")[0];

  if (/\.myworkday(jobs|site)\.com$/.test(host)) {
    // …/job/<location>/<title>_<REQ>[-N]: "-N" numbers the same requisition's postings in other locations.
    // The REQ itself can hold a hyphen ("JR-0110807"): only a short number after a digit is a copy number.
    const slug = seg.slice(seg.indexOf("job") + 1).find((s) => s.includes("_"));
    const req = slug
      ?.split("_")
      .pop()
      ?.replace(/(?<=\d)-\d{1,2}$/, "");
    if (req) return `workday:${tenant}:${req.toLowerCase()}`;
  }
  // Greenhouse ids are global: a company page's gh_jid and the board's /jobs/<id> name the same posting.
  const gh = q("gh_jid") ?? (/greenhouse\.io$/.test(host) ? (q("token") ?? after("jobs")) : undefined);
  if (gh && /^\d+$/.test(gh)) return `greenhouse:${gh}`;
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return `lever:${seg[1] ?? ""}`;
  if (host === "jobs.ashbyhq.com") return `ashby:${seg[1] ?? ""}`;
  if (host.endsWith("smartrecruiters.com") && seg[1]) return `sr:${seg[1].split("-")[0]}`;
  if (host === "apply.workable.com" && seg[1] === "j") return `workable:${seg[2] ?? ""}`;
  if (host.endsWith("linkedin.com") && seg[0] === "jobs" && seg[1] === "view")
    return `linkedin:${/(\d+)$/.exec(seg[2] ?? "")?.[1] ?? seg[2]}`;
  if (host.endsWith("indeed.com") && q("jk")) return `indeed:${q("jk")}`;
  if (/(^|\.)glassdoor\.[a-z.]+$/.test(host) && (q("jl") ?? q("joblistingid")))
    return `glassdoor:${q("jl") ?? q("joblistingid")}`;
  if (host.endsWith("ziprecruiter.com") && q("jid")) return `ziprecruiter:${q("jid")}`;
  if (seg.includes("CandidateExperience") && after("job")) return `oracle:${host}:${after("job")}`;
  if (q("ats") === "successfactors" || host.endsWith("successfactors.com")) {
    const id = q("jobid") ?? q("career_job_req_id") ?? seg.find((s) => /^\d{6,}$/.test(s));
    if (id) return `sf:${host}:${id}`;
  }
  // Eightfold names a posting by path (/careers/job/<id>) or by ?pid=<id> on /careers.
  const ef = after("job") ?? q("pid");
  if (host.endsWith("eightfold.ai") && ef) return `eightfold:${host}:${ef}`;
  if (host.endsWith("icims.com") && after("jobs")) return `icims:${host}:${after("jobs")}`;

  const path = seg
    .join("/")
    .replace(/\/(apply(\/applymanually)?|application|thanks|confirmation)$/i, "")
    .toLowerCase();
  const ids = ID_PARAMS.flatMap((k) => (q(k) ? [`${k}=${q(k)}`] : [])).join("&");
  return `${host}/${path}${ids ? `?${ids}` : ""}`;
}

/**
 * Whether the address names one posting. SuccessFactors' shared application page ("career4.successfactors.com/careers
 * ?company=X") names none: as every Acuity job's key, the first one's record read as "already applied" for the next.
 * Nor does a site's root, a locale root ("careers.x.com/us/en") or a sign-in page ("passport.amazon.jobs/"): one
 * Amazon job that failed at sign-in skipped the next as applied.
 */
export function namesPosting(raw: string): boolean {
  const key = jobKey(raw);
  if (/^[^/:]*successfactors\.(com|eu)\//.test(key)) return false; // SAP's is career5.successfactors.eu
  // A Workday page without a requisition is the site's home, sign-in or candidate home ("…/Altera/userHome").
  if (/^[^/:]*\.myworkday(jobs|site)\.com\//.test(key)) return false;
  const generic = /^[^/:]+\/([^?]*)$/.exec(key); // no ATS id and no id parameter
  if (!generic) return true;
  const segs = generic[1].split("/").filter((s) => s && !/^[a-z]{2}([-_][a-z]{2})?$/.test(s));
  return segs.length > 0 && !segs.every((s) => /log-?in|sign-?(in|on|up)|auth|sso|identity|account|register/.test(s));
}

const TITLE_FORMS: [RegExp, string][] = [
  [/\b(20\d\d|summer|fall|autumn|winter|spring|\d+ ?months?|full ?time|part ?time)\b/g, ""],
  [/\bengineering\b/g, "engineer"],
  [/\bdevelopment\b/g, "developer"],
  [/\b(internships?|interns|co ?op|coop)\b/g, "intern"],
];

/**
 * Company and title, as boards and the employer's own posting both word them: the same job reached through
 * another source ("Software Engineering Intern (Summer 2027)" on Glassdoor, "Software Engineer Intern" on the ATS)
 * or another requisition copy. Places are left out: boards shorten them ("Ottawa" for "Kanata, Ottawa, ON").
 */
export function altKey(company: string, title: string): string {
  let t = normalize(title);
  for (const [re, to] of TITLE_FORMS) t = t.replace(re, to);
  const c = normalize(company).replace(/\b(inc|llc|ltd|corp|corporation|co)\b/g, "");
  return `${c.replace(/\s+/g, " ").trim()}|${t.replace(/\s+/g, " ").trim()}`;
}

/**
 * Where a resumed application starts over. A SuccessFactors run stopped mid sign-in keeps that page's session-bound
 * address (Teck's "login_ns=forgot_pwd&requestParams=…"): Resume reopened the password reset instead of the job.
 * Its posting's own link starts the job again; other addresses stay as they are.
 */
export function restartUrl(raw: string): string {
  const u = parse(raw);
  if (!u || !/(^|\.)(successfactors\.(com|eu)|ns2cloud\.com)$/i.test(u.hostname)) return raw;
  const q = (k: string) => [...u.searchParams].find(([p]) => p.toLowerCase() === k)?.[1];
  const [company, id] = [q("company"), q("career_job_req_id")];
  if (!company || !id) return raw;
  return `${u.origin}/career?career_ns=job_listing&company=${encodeURIComponent(company)}&career_job_req_id=${encodeURIComponent(id)}`;
}

/** Where an application starts: the ATS's own form page, skipping its description page where the URL allows. */
export function applyUrl(raw: string): string {
  const u = parse(raw);
  if (!u) return raw;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^(ref|source|src)$/i.test(k)) u.searchParams.delete(k);
  if ((host === "jobs.lever.co" || host === "jobs.eu.lever.co") && path.split("/").length === 3)
    u.pathname = `${path}/apply`;
  else if (host === "jobs.ashbyhq.com" && path.split("/").length === 3) u.pathname = `${path}/application`;
  else if (/\.myworkday(jobs|site)\.com$/.test(host) && path.includes("/job/") && !path.includes("/apply"))
    u.pathname = `${path}/apply/applyManually`;
  else if (host === "apply.workable.com" && /\/j\/[^/]+$/.test(path)) u.pathname = `${path}/apply`;
  return u.toString();
}
