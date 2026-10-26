// YOLO mode: finds new postings on a timer and applies to them end to end (src/background/yolo).
import { z } from "zod";

const b = (d: boolean) => z.boolean().catch(d);
const n = (d: number, min: number, max: number) => z.number().int().min(min).max(max).catch(d);
const strs = (d: string[] = []) => z.array(z.string()).catch(d);

export const SIMPLIFY_FEED =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json";

/** Job boards searched with the user's queries. They only find jobs: applying happens on the employer's own site. */
export const BOARDS = ["linkedin", "indeed", "glassdoor"] as const;
export type Board = (typeof BOARDS)[number];

const base = z.object({
  enabled: b(false),
  intervalMin: n(30, 5, 1440),
  /** 0 finds jobs without applying (a dry run). */
  dailyCap: n(25, 0, 500),
  queries: strs(),
  locations: strs(),
  remoteOk: b(true),
  postedWithinDays: n(14, 1, 90),
  excludeTitleWords: strs(["senior", "sr", "staff", "principal", "lead", "manager", "director", "ii", "iii", "phd"]),
  skipCompanies: strs(),
  aiRelevanceCheck: b(true),
  boards: z.array(z.enum(BOARDS)).catch(["linkedin", "indeed", "glassdoor"]),
  feeds: strs([SIMPLIFY_FEED]),
  careerSites: strs(),
  email: z.string().catch(""),
  gmailClientId: z.string().catch(""),
  reapplyManual: b(false),
  warnOnYoloApplied: b(true),
  tabFallback: b(true),
});
export const YoloSchema = base.catch(() => base.parse({}));
export type Yolo = z.infer<typeof YoloSchema>;
export const defaultYolo = (): Yolo => YoloSchema.parse({});

/** A posting found by a source. */
export interface Listing {
  url: string;
  company: string;
  title: string;
  location: string;
  postedAt?: number;
  source: string;
  /** Applied to on the board itself (LinkedIn Easy Apply, Indeed Apply): not supported yet, so never queued. */
  easyApply?: boolean;
}

export const QueueItemSchema = z.object({
  key: z.string(),
  alt: z.string().catch(""),
  /** The posting's key as found: a board listing's, when `url` is the employer's own posting. */
  listing: z.string().catch(""),
  url: z.string(),
  company: z.string().catch(""),
  title: z.string().catch(""),
  location: z.string().catch(""),
  source: z.string().catch(""),
  postedAt: z.number().catch(0),
  addedAt: z.number().catch(0),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const ApplicationSchema = QueueItemSchema.omit({ listing: true, postedAt: true, addedAt: true }).extend({
  /** The confirmation page a submission ended on. */
  doneUrl: z.string().catch(""),
  mode: z.enum(["yolo", "manual"]).catch("yolo"),
  status: z.enum(["submitted", "needs", "failed", "skipped"]).catch("failed"),
  reason: z.string().catch(""),
  /** Answers YOLO made up where the profile had none, for the user to review. */
  guesses: z.array(z.object({ q: z.string(), a: z.string() })).catch([]),
  at: z.number().catch(0),
});
export type Application = z.infer<typeof ApplicationSchema>;
export type Guess = Application["guesses"][number];

export const VaultEntrySchema = z.object({
  email: z.string(),
  iv: z.string(),
  ct: z.string(),
  createdAt: z.number().catch(0),
});

export const YoloStateSchema = z.object({
  lastCheckAt: z.number().catch(0),
  pausedUntil: z.number().catch(0),
  pauseReason: z.string().catch(""),
  gmailNeedsAuth: b(false),
});
export type YoloState = z.infer<typeof YoloStateSchema>;

export interface YoloStatus {
  enabled: boolean;
  /** Search queries set: YOLO has something to look for. */
  searches: number;
  appliedToday: number;
  cap: number;
  queued: number;
  needsYou: number;
  nextCheckAt: number | null;
  running: string | null;
  paused: string;
}
