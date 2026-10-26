// Which found postings YOLO applies to: the user's queries, places, age and exclusions, decided locally.
import { canonicalCountry } from "../../shared/constants";
import { normalize } from "../../shared/normalize";
import type { Listing, Yolo } from "../../shared/yolo";
import { jobCountry } from "../services/mapFields";

const SYNONYMS = [
  ["intern", "internship", "coop", "co op", "work term", "placement"],
  ["engineer", "engineering", "developer", "development", "swe", "sde"],
  ["software", "swe", "sde"],
  ["data", "analytics"],
  ["ml", "machine learning", "ai"],
];
const forms = (w: string) => [w, `${w}s`, `${w}es`, `${w}ing`, `${w}ship`, `${w}ships`, w.replace(/s$/, "")];

/** Every word of the query appears in the title, as itself, a plural/-ing/-ship form, or a synonym. */
export function titleMatches(title: string, query: string): boolean {
  const t = ` ${normalize(title)} `;
  return normalize(query)
    .split(" ")
    .filter(Boolean)
    .every((w) => {
      const group = SYNONYMS.find((g) => g.some((s) => forms(s).includes(w))) ?? [w];
      return [...group, w].some((s) => forms(s).some((f) => t.includes(` ${f} `)));
    });
}

const RE_REMOTE = /\b(remote|anywhere|work from home)\b/i;

/**
 * Places are ";"-separated. A wanted place that is a country matches a place in it (cities, provinces and hubs
 * resolve through the profile's country tables); any other wanted place matches by name. Remote places match when
 * remote work is allowed and they name no other country.
 */
export function locationMatches(location: string, wanted: string[], remoteOk: boolean): boolean {
  if (!wanted.length) return true;
  return location.split(/[;|]/).some((place) => {
    const remote = RE_REMOTE.test(place);
    const rest = place.replace(/\b(remote|anywhere)\b( in| -|,)?/gi, "").trim();
    const country = rest ? (jobCountry(rest) ?? canonicalCountry(rest)) : undefined;
    if (remote && remoteOk && (!country || wanted.some((w) => canonicalCountry(w) === country))) return true;
    return wanted.some((w) => {
      const c = canonicalCountry(w);
      return c ? c === country : normalize(place).includes(normalize(w));
    });
  });
}

/** Why a posting is not for this user, or null when it is. */
export function rejectReason(l: Listing, y: Yolo, now = Date.now()): string | null {
  if (l.easyApply) return "Easy Apply (not supported yet)";
  if (!y.queries.some((q) => titleMatches(l.title, q))) return "Title doesn't match a search";
  const t = ` ${normalize(l.title)} `;
  const bad = y.excludeTitleWords.find((w) => normalize(w) && t.includes(` ${normalize(w)} `));
  if (bad) return `Title has "${bad}"`;
  const company = normalize(l.company);
  if (y.skipCompanies.some((c) => normalize(c) === company)) return "Company skipped";
  // A career site the user pasted is already their own search: its pages rarely state where each job is.
  if (!(l.source === "careers" && !l.location) && !locationMatches(l.location, y.locations, y.remoteOk))
    return "Location";
  if (l.postedAt && now - l.postedAt > y.postedWithinDays * 86400e3) return "Too old";
  return null;
}
