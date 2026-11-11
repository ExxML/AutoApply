import { postingFacts } from "../content/jobContextExtract";

/**
 * A posting's company, job title and posting date, from the JSON-LD job boards and ATSs publish for search engines
 * (Greenhouse, Lever, Ashby, Workday, LinkedIn): empty where the page has none. Sent without the user's cookies.
 */
export async function readPosting(url: string): Promise<{ company: string; title: string; postedAt?: number }> {
  try {
    const r = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(10_000) });
    // Its JSON-LD blocks alone: parsing the whole page logs a CSP violation for each inline event handler in it.
    const blocks = r.ok ? (await r.text()).match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) : null;
    return postingFacts(new DOMParser().parseFromString(blocks?.join("") ?? "", "text/html"));
  } catch {
    return { company: "", title: "" };
  }
}
