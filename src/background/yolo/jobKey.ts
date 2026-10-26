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
const ID_PARAMS = ["gh_jid", "jk", "jobid", "job", "id", "req", "requisitionid", "token", "for"];

export function jobKey(raw: string): string {
  const u = parse(raw);
  if (!u) return raw.trim().toLowerCase();
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const q = (k: string) => [...u.searchParams].find(([p]) => p.toLowerCase() === k)?.[1];
  const after = (s: string) => seg[seg.indexOf(s) + 1];
  const tenant = host.split(".")[0];

  if (/\.myworkday(jobs|site)\.com$/.test(host)) {
    // …/job/<location>/<title>_<REQ>[-N]: "-N" numbers the same requisition's postings in other locations.
    const slug = seg.slice(seg.indexOf("job") + 1).find((s) => s.includes("_"));
    const req = slug?.split("_").pop()?.replace(/-\d+$/, "");
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
  if (seg.includes("CandidateExperience") && after("job")) return `oracle:${host}:${after("job")}`;
  if (q("ats") === "successfactors" || host.endsWith("successfactors.com")) {
    const id = q("jobid") ?? seg.find((s) => /^\d{6,}$/.test(s));
    if (id) return `sf:${host}:${id}`;
  }
  if (host.endsWith("eightfold.ai") && after("job")) return `eightfold:${host}:${after("job")}`;
  if (host.endsWith("icims.com") && after("jobs")) return `icims:${host}:${after("jobs")}`;

  const path = seg
    .join("/")
    .replace(/\/(apply(\/applymanually)?|application|thanks|confirmation)$/i, "")
    .toLowerCase();
  const ids = ID_PARAMS.flatMap((k) => (q(k) ? [`${k}=${q(k)}`] : [])).join("&");
  return `${host}/${path}${ids ? `?${ids}` : ""}`;
}

/** Company, title and city: the same posting reached through a board's own id or another requisition copy. */
export function altKey(company: string, title: string, location: string): string {
  const city = normalize(location.split(/[,;|(]/)[0] ?? "");
  return `${normalize(company)
    .replace(/\b(inc|llc|ltd|corp|corporation|co)\b/g, "")
    .trim()}|${normalize(title)}|${city}`;
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
