// YOLO coordinator: the check timer, the queue, the application log, and every message of a run. With YOLO off no
// alarm exists, so none of this runs.
import type { Message, Responses, YoloResult } from "../../shared/messages";
import { RE_APPLIED, SLEPT_MS } from "../../shared/constants";
import { isTailoredDoc, resumeProblem } from "../../shared/resumeMode";
import { createStorage, session } from "../../shared/storage";
import type { AiTask } from "../../shared/settings";
import type { ApiError, DocumentMeta, Settings } from "../../shared/types";
import {
  defaultYolo,
  hasReviewRules,
  isPendingApplication,
  type Application,
  type Guess,
  type Listing,
  type QueueItem,
  type Yolo,
  type YoloState,
} from "../../shared/yolo";
import { RELEVANCE_PROMPT } from "../gemini/prompts";
import { RELEVANCE_SCHEMA, RelevanceZ } from "../gemini/schemas";
import { draftEssays } from "../services/draftEssays";
import { FALLBACK, tailoredDoc } from "../services/tailorResume";
import { jobBrief } from "../services/jobBrief";
import { compactProfile, type ServiceCtx } from "../services/mapFields";
import { getJobContext } from "../jobContext";
import { realInput, realInputReady, releaseRealInput } from "./realInput";
import { markApplicationSubmitted, recordApplication, updateApplications, updateQueue } from "./applicationStore";
import { nextPendingResume, pendingResumeKeys, pendingResumeStarted, queuePendingResumes } from "./pendingResumes";
import { completedSince, needsReviewTab, pendingReview, reviewReasons } from "./submissionReview";
import {
  dismissReview,
  initReviewTabs,
  nextReviewRefill,
  openReview,
  queueReviewRefill,
  releaseReview,
  retainReview,
  reviewAttempt,
  reviewList,
  reviewRefillStarted,
  submitReview,
} from "./reviewTabs";
import { confirmation, confirmFirst, kindOf, refused, signature, verifyFailed } from "./classify";
import { applied, discover, indeedSignedOutNow, inQueueOrder, readIndeed, RETRY } from "./discover";
import {
  checkGmail,
  connectGmail,
  GmailAuthError,
  gmailToken,
  siteOfUrl,
  waitForEmail,
  waitForFeedCode,
} from "./gmail";
import { closeFrame, openTab } from "./host";
import { altKey, applyUrl, jobKey, namesPosting } from "./jobKey";
import { indeedCardsInPage, JOBRIGHT_PING } from "./sources";
import { failSourceCheck, plainError } from "./sourceCheck";
import { letterText, textPdf } from "./pdf";
import {
  credit,
  end,
  fromRun,
  getRun,
  overdue,
  resolveScrape,
  REVIEW_RUN_MS,
  saveRun,
  scrape,
  start,
  watchTab,
  WATCHDOG,
  woke,
  type Run,
} from "./runner";
import { createAccount, deleteAccount, getAccount } from "./vault";

const store = createStorage("background");
const CHECK = "yolo";
const RESUME = "yolo-resume";
/** `yolo-online|<what>|<tries>`: a batch step held until the network is back after the computer woke. */
const ONLINE = "yolo-online";
const WAKING = "Resuming after sleep";

type Handler<T extends Message["type"]> = (
  msg: Extract<Message, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<Responses[T]>;

export interface YoloDeps {
  serviceCtx: (task?: AiTask) => Promise<ServiceCtx | { error: ApiError }>;
  /** How many applications' debug logs to keep: 0 with debug logging off. */
  logLimit: () => number;
}

let yolo: Yolo = defaultYolo();
let deps: YoloDeps;

const hostOf = (u: string) => new URL(u).hostname.replace(/^www\./, "");
const submittedSince = (apps: Application[], since: number) =>
  apps.filter((a) => a.mode === "yolo" && a.status === "submitted" && a.at >= since).length;

async function setState(patch: Partial<YoloState>) {
  await store.set({ yoloState: { ...(await store.get("yoloState")), ...patch } });
}

function notify(id: string, title: string, message: string) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title,
    message,
    priority: 1,
  });
}

/** Later answers to the same question replace earlier ones (a page re-filled after a validation error). */
const mergeGuesses = (a: Guess[], b: Guess[] = []) => [...a.filter((g) => !b.some((x) => x.q === g.q)), ...b];

/** One record per posting: a later outcome (the user resuming a "needs you") replaces the earlier one. */
async function record(a: Application) {
  await recordApplication(a);
}

// ---------- timer ----------
/** Matches the alarm to the settings: one batch every interval while on and searching for something. */
async function schedule() {
  const on = yolo.enabled && yolo.queries.length > 0;
  const a = await chrome.alarms.get(CHECK);
  if (!on) {
    if (a) await chrome.alarms.clearAll();
    const run = await getRun();
    if (
      run &&
      !run.reviewKey &&
      !run.resumeKey &&
      (await end(run.id)) &&
      run.mode === "apply" &&
      run.host !== "visible"
    ) {
      // Past Submit it may have gone through: left for the user to check rather than applied to twice.
      if (run.confirming)
        await record(
          await outcome(run, { status: "needs", reason: "YOLO was turned off before the emailed confirmation" }),
        );
      else await requeue(run.item);
    }
    await closeFrame().catch(() => undefined);
    return;
  }
  if (a?.periodInMinutes !== yolo.intervalMin)
    await chrome.alarms.create(CHECK, {
      periodInMinutes: yolo.intervalMin,
      delayInMinutes: a ? yolo.intervalMin : 0.5,
    });
}

/** Bound: a detached `fetch` called as a method throws "Illegal invocation". */
const fetcher = (url: string, init?: RequestInit) => fetch(url, init);
/** How long discovery waits on the user to clear Indeed's bot check before going on without Indeed. */
const INDEED_WAIT_MS = 10 * 60e3;
const INDEED_NOTE = "yolo-indeed";
const INDEED_PAUSE = "Waiting for you to tick Indeed's bot check in the tab YOLO opened";
/** The tab YOLO opened on Indeed for the user to clear its bot check in; Indeed's next blocked search reuses it. */
let indeedTabId: number | undefined;
/** Discovery is waiting on the user to clear Indeed's bot check: no application starts meanwhile. */
let indeedWaiting = false;

/**
 * An Indeed search Cloudflare checked the fetch of, read in a visible tab once the user has cleared the check there:
 * The user is notified and the tab brought forward. null = closed, or not cleared in time.
 */
async function indeedTab(url: string): Promise<string | null> {
  const old = indeedTabId === undefined ? null : await chrome.tabs.get(indeedTabId).catch(() => null);
  // Reused only while it's still on Indeed: the user may have gone elsewhere in it.
  if (old?.id !== undefined && /(^|\.)indeed\.com$/.test(new URL(old.url || old.pendingUrl || "about:blank").hostname))
    await chrome.tabs.update(old.id, { url });
  else indeedTabId = await openTab(url, true);
  const id = indeedTabId!;
  indeedWaiting = true;
  let asked = false;
  try {
    for (const end = Date.now() + INDEED_WAIT_MS; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 1000));
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) return null;
      // Fails while the page navigates (a passed check reloads it); asked again a second later.
      const [hit] = await chrome.scripting
        .executeScript({ target: { tabId: id }, func: indeedCardsInPage })
        .catch(() => []);
      if (hit?.result != null) return hit.result;
      // Still checked once loaded (a cleared tab reads within a few seconds): the user's to tick.
      if (!asked && tab.status === "complete") {
        asked = true;
        await chrome.tabs.update(id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
        notify(
          INDEED_NOTE,
          "Indeed needs you",
          'Tick Indeed\'s "Verify you are human" box in the tab YOLO opened. YOLO holds off applying until then.',
        );
        await setState({ indeedBlocked: true, pauseReason: INDEED_PAUSE });
      }
    }
    return null;
  } finally {
    indeedWaiting = false;
    void chrome.notifications.clear(INDEED_NOTE);
    if ((await store.get("yoloState")).pauseReason === INDEED_PAUSE) await setState({ pauseReason: "" });
  }
}

let cycling: Promise<void> | null = null;
let toppingUp = false;
/** The batch (its `batchAt`) whose last discovery found nothing new: no top-up until the next batch. */
let dryBatch = 0;

/** Gives a manually started batch a fresh budget and a full interval before the next scheduled discovery. */
async function resetBatch(queueOnlyBatch = false) {
  const batchAt = Date.now();
  await chrome.alarms.create(CHECK, {
    when: batchAt + yolo.intervalMin * 60_000,
    periodInMinutes: yolo.intervalMin,
  });
  const state = await store.get("yoloState");
  await setState({ batchAt, queueOnlyBatch, pauseReason: state.pausedUntil > batchAt ? state.pauseReason : "" });
}

/**
 * One batch: discovery, then applying to up to `batchSize` jobs. A run in the host keeps it busy, so rendered sources
 * wait for the next batch; a run still going from the last batch counts toward this one. `topUp`: more discovery for
 * the current batch, its queue having run dry.
 */
function cycle(topUp = false): Promise<void> {
  // A batch's own check waits out a top-up instead of being skipped for it, so its `batchAt` still starts a new batch.
  const again = () => cycle();
  if (cycling && toppingUp && !topUp) return cycling.then(again, again);
  return (cycling ??= (async () => {
    toppingUp = topUp;
    // The turn-on check holds the hidden host; waiting it out keeps Indeed and career pages in this batch.
    await checking;
    let batchAt = 0;
    let added = 0;
    try {
      if (!yolo.enabled || !yolo.queries.length) return;
      if (!topUp) await setState({ batchAt: Date.now(), queueOnlyBatch: false, pauseReason: "" });
      const [busy, state] = await Promise.all([getRun(), store.get("yoloState")]);
      batchAt = state.batchAt;
      added = await discover({
        yolo,
        fetch: fetcher,
        scrape: busy ? undefined : scrape,
        indeedTab,
        relevance: yolo.aiRelevanceCheck ? relevance : undefined,
        jobrightSignedOut: (out) => setState({ jobrightSignedOut: out }),
        indeedSignedOut: (out) => setState({ indeedSignedOut: out }),
        indeedBlocked: (blocked) => setState({ indeedBlocked: blocked }),
        topUp,
      });
      await setState({ lastCheckAt: Date.now() });
    } catch (e) {
      console.warn("[AutoApply] YOLO check failed:", (e as Error)?.message);
      await failSourceCheck(plainError(e)).catch(() => undefined);
    } finally {
      cycling = null;
    }
    // Failed or found nothing: topping up again would repeat it.
    if (batchAt && !added) dryBatch = batchAt;
    await pump();
  })());
}

let checking: Promise<void> | null = null;
/**
 * At turn-on, whether Jobright and Indeed can be read (each signed in, and Indeed's search not bot-checked), so the
 * popup shows it within seconds rather than once the first batch's discovery reaches them. Discovery keeps the flags
 * current after that.
 */
async function checkSources() {
  const indeedOut = await checkSignIns({ jobright: yolo.jobright.length > 0, indeed: yolo.boards.includes("indeed") });
  // Signed in: whether its search is bot-checked, read as discovery reads it.
  if (indeedOut === false && yolo.queries.length) {
    const q = [yolo.queries[0], yolo.locations[0] ?? "", yolo.postedWithinDays] as const;
    // The fetch only: the batch's discovery, moments later, asks the user to clear a bot check.
    const list = await readIndeed({ fetch: fetcher }, ...q).catch(() => undefined);
    if (list !== undefined) await setState({ indeedBlocked: !list });
  }
}

/**
 * Whether the user is signed in to the sources asked for (one tiny request each), recorded for the popup and settings
 * to warn. Returns Indeed's answer: null if it wasn't asked or couldn't be.
 */
async function checkSignIns(which: { jobright: boolean; indeed: boolean }): Promise<boolean | null> {
  const [jobright, indeed] = await Promise.all([
    which.jobright ? fetch(JOBRIGHT_PING, { credentials: "include" }).catch(() => null) : null,
    which.indeed ? indeedSignedOutNow(fetcher) : null,
  ]);
  // One write: state is read and written whole.
  const patch: Partial<YoloState> = {};
  if (jobright) patch.jobrightSignedOut = jobright.status === 401;
  if (indeed !== null) patch.indeedSignedOut = indeed;
  if (Object.keys(patch).length) await setState(patch);
  return indeed;
}

/** The queue ran dry with the batch short of `batchSize`: finds more now rather than at the next batch. */
async function topUp(): Promise<boolean> {
  const [state, next] = await Promise.all([store.get("yoloState"), chrome.alarms.get(CHECK)]);
  if (state.queueOnlyBatch) return false;
  // Not when the next batch, which discovers anyway, is due within minutes (or YOLO was just turned on).
  if (!next || next.scheduledTime - Date.now() < 5 * 60e3) return false;
  if (cycling || !yolo.queries.length || state.batchAt === dryBatch || state.pausedUntil > Date.now()) return false;
  if (completedSince(await store.get("applications"), state.batchAt) >= yolo.batchSize) return false;
  void cycle(true);
  return true;
}

async function relevance(items: Listing[]): Promise<Set<number>> {
  const all = new Set(items.keys());
  const ctx = await deps.serviceCtx();
  if ("error" in ctx) return all;
  const p = await store.get("profile");
  const r = await ctx.ai
    .call(
      {
        system: RELEVANCE_PROMPT,
        payload: {
          queries: yolo.queries,
          candidate: compactProfile({
            education: p.education.map(({ degree, degreeLevel, major, expectedGraduation, yearLevel }) => ({
              degree,
              degreeLevel,
              major,
              expectedGraduation,
              yearLevel,
            })),
            workAuthorization: p.workAuthorization.entries,
            home: p.personal.address.country,
            willingToRelocate: p.preferences.willingToRelocate,
          }),
          jobs: items.map((l, i) => ({ i, title: l.title, company: l.company, location: l.location })),
        },
        schema: RELEVANCE_SCHEMA,
        validate: (d) => RelevanceZ.parse(d),
        timeoutMs: ctx.settings.requestTimeoutMs,
      },
      { model: ctx.model, fallback: ctx.fallback },
    )
    .catch(() => null);
  return r ? new Set(r.data.keep) : all;
}

/** Why YOLO can't upload résumés in its mode (Variant select with none, AI tailor without a .tex); "" when it can. */
async function resumeBlocker(): Promise<string> {
  const s = await store.getMany(["documentsIndex", "tailorResume"]);
  return resumeProblem(yolo.resumeUpload, s.documentsIndex, !!s.tailorResume, "YOLO");
}

// ---------- queue ----------
let pumping = false;
/** Starts the next queued job when nothing runs, the batch has room, and the AI is usable. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    if (await getRun()) return;
    const state = await store.get("yoloState");
    if (state.pausedUntil > Date.now()) return;
    const refill = await nextReviewRefill();
    if (refill) {
      await releaseReview(refill.key, true);
      await start({ ...refill, listing: "", postedAt: 0, addedAt: Date.now() }, "apply", "visible", {
        policy: { ...yolo.submissionReview, mode: "all" },
        key: refill.key,
        tab: true,
      });
      await reviewRefillStarted();
      return;
    }
    for (let pending = await nextPendingResume(); pending; pending = await nextPendingResume()) {
      const reviews = await reviewList();
      if (reviews.live.includes(pending.key)) {
        await pendingResumeStarted(pending.key);
        continue;
      }
      if (reviews.live.length >= yolo.submissionReview.maxPending) {
        await setState({
          pauseReason: `Review tab limit reached (${yolo.submissionReview.maxPending}). Submit or dismiss a review to continue resuming.`,
        });
        return;
      }
      if (pending.review) await releaseReview(pending.key, true);
      await setState({ pauseReason: "" });
      await startResumed(pending, "tab");
      await pendingResumeStarted(pending.key);
      return;
    }
    if (!yolo.enabled) return;
    // The user is asked to clear Indeed's bot check: applying waits for the check to read Indeed.
    if (indeedWaiting) return;
    const apps = await store.get("applications");
    const policy = yolo.submissionReview;
    if (policy.mode === "matching" && !hasReviewRules(policy)) {
      await setState({ pauseReason: "Select at least one review rule in YOLO settings" });
      return;
    }
    if (policy.mode !== "off" && apps.filter(pendingReview).length >= policy.maxPending) {
      await setState({
        pauseReason: `Review limit reached (${policy.maxPending}). Submit or dismiss a pending review.`,
      });
      await closeFrame().catch(() => undefined);
      return;
    }
    const queue = await store.get("yoloQueue");
    if (!queue.length) return void ((await topUp()) || (await closeFrame().catch(() => undefined)));
    if (completedSince(apps, state.batchAt) >= yolo.batchSize) {
      await setState({ pauseReason: "Batch done" });
      return void (await closeFrame().catch(() => undefined));
    }
    const ctx = await deps.serviceCtx();
    if ("error" in ctx) return void (await setState({ pauseReason: ctx.error.message }));
    const blocked = await resumeBlocker();
    if (blocked) return void (await setState({ pauseReason: blocked }));
    let item: QueueItem | undefined;
    // Taken from the queue as it is now (discovery or a requeue may have changed it since), dropping jobs already in
    // Applications: discovery can queue one in the moment between its run ending and its result being recorded.
    // Requeued jobs were put back on purpose.
    await updateQueue((q) => {
      const ok = (i: QueueItem) => i.postedAt === RETRY || !applied(apps, i.key, i.alt, yolo.reapplyManual);
      const [first, ...rest] = inQueueOrder(q.filter(ok), yolo);
      item = first;
      // Its other copies too: a requeued copy would skip the already-applied check above.
      return rest.filter((i) => i.key !== first?.key);
    });
    if (!item) return;
    await setState({ pauseReason: "" });
    const tab = yolo.tabFallback && (await store.get("yoloTabHosts")).includes(hostOf(applyUrl(item.url)));
    const reviewTab = needsReviewTab(policy, item);
    await start(
      item,
      "apply",
      tab || reviewTab ? "tab" : "frame",
      policy.mode === "off" ? undefined : { policy, tab: reviewTab },
    );
  } finally {
    pumping = false;
  }
}

async function pause(until: number, reason: string) {
  await setState({ pausedUntil: until, pauseReason: reason });
  await chrome.alarms.create(RESUME, { when: until });
}

async function requeue(item: QueueItem, resumeKey?: string) {
  if (resumeKey) {
    if ((await store.get("applications")).some((a) => a.key === resumeKey && isPendingApplication(a)))
      await queuePendingResumes([resumeKey]);
    return;
  }
  const held = (await store.get("applications")).find((a) => a.key === item.key && pendingReview(a));
  if (held) {
    await queueReviewRefill(held.key);
    return;
  }
  // Replaces any copy already queued: two recoveries racing on one in-flight job would otherwise queue it twice, and
  // requeued jobs skip the already-applied check.
  await updateQueue((q) => [{ ...item, postedAt: RETRY }, ...q.filter((i) => i.key !== item.key)]);
}

/**
 * After the computer wakes (or the browser starts): the next pump or check 30 s on, once the network is back (Wi-Fi
 * reconnects after the computer does). Still offline after 5 minutes, it goes ahead anyway.
 */
async function whenOnline(what: "pump" | "check", tries = 0) {
  const until = Date.now() + 30_000;
  // Holds other pumps off meanwhile, short of a longer pause (an AI usage limit's).
  if (what === "pump" && (await store.get("yoloState")).pausedUntil < until)
    await setState({ pausedUntil: until, pauseReason: WAKING });
  await chrome.alarms.create(`${ONLINE}|${what}|${tries}`, { delayInMinutes: 0.5 });
}

async function online(alarm: string) {
  const [, what, tries] = alarm.split("|") as [string, "pump" | "check", string];
  if (!navigator.onLine && +tries < 10) return whenOnline(what, +tries + 1);
  if (what === "check") return cycle();
  if ((await store.get("yoloState")).pauseReason === WAKING) await setState({ pauseReason: "" });
  await pump();
}

/** A hidden application the computer's sleep likely broke: it failed moments after waking, before submitting. */
async function sleptThrough(run: Run, r: YoloResult): Promise<boolean> {
  if (run.mode !== "apply" || run.host === "visible" || run.confirming || (run.item.retries ?? 0) >= 2) return false;
  if (r.status === "submitted" || r.status === "skipped" || ("retryAt" in r && r.retryAt)) return false;
  const now = Date.now();
  if (woke(run, now)) return true;
  // Woken just now, before the watchdog's late tick.
  const due = (await chrome.alarms.get(WATCHDOG))?.scheduledTime;
  return !!due && now - due > SLEPT_MS;
}

/** A browser restart lost the run (session storage) mid-application: its job goes back to the front of the queue. */
export async function recoverLost() {
  const item = await store.get("yoloInFlight");
  if (!item || (await getRun())) return;
  await store.set({ yoloInFlight: null });
  // A worker may have stopped after saving the handoff and before clearing its in-flight marker.
  if (
    (await store.get("applications")).some(
      (a) => a.review && (a.key === item.key || (!!item.alt && a.alt === item.alt)),
    )
  )
    return;
  // Recorded, so the next check doesn't queue it again: past Submit it may have gone through, and a page that keeps
  // crashing the browser would loop.
  const { submitted, ...job } = item;
  if (submitted || (item.retries ?? 0) >= 2)
    return record({
      ...job,
      url: applyUrl(item.url),
      doneUrl: "",
      mode: "yolo",
      status: submitted ? "needs" : "failed",
      reason: submitted
        ? "The browser restarted before the emailed confirmation"
        : "The browser restarted during this application twice",
      guesses: [],
      notes: [],
      at: Date.now(),
    });
  await requeue({ ...item, retries: (item.retries ?? 0) + 1 });
  if (yolo.enabled) await whenOnline("pump");
}

/**
 * A run's outcome: started again when the computer's sleep broke it, retried in a tab when the hidden frame was
 * refused, re-queued on a quota stop, else logged.
 */
async function finish(run: Run, r: YoloResult) {
  if (run.reviewTab && run.tabId !== undefined && (r.status === "needs" || r.status === "failed") && !r.retryAt) {
    await holdForReview(run, "needs", r.reason);
    return;
  }
  if (await sleptThrough(run, r)) {
    if (!(await end(run.id))) return;
    const limit = deps.logLimit();
    if (limit) await logRun(run, r, limit);
    await requeue({ ...run.item, retries: (run.item.retries ?? 0) + 1 }, run.resumeKey);
    return whenOnline("pump");
  }
  if (!(await end(run.id))) return;
  if (run.mode === "scrape") return resolveScrape(run, r);
  const limit = deps.logLimit();
  if (limit) await logRun(run, r, limit);
  if (r.status === "blocked" && run.host === "frame" && yolo.tabFallback) {
    // From the embedded form itself: Lyft's CareerPuck page, which framed its Greenhouse form, renders nothing in a
    // background tab.
    await start(
      run.embedUrl ? { ...run.item, url: run.embedUrl } : run.item,
      "apply",
      "tab",
      run.reviewPolicy
        ? {
            policy: run.reviewPolicy,
            key: run.reviewKey,
            tab: !!run.reviewTab,
          }
        : undefined,
      run.resumeKey,
    );
    return;
  }
  if (r.status !== "submitted" && r.status !== "scraped" && r.retryAt) {
    await requeue(run.item, run.resumeKey);
    await pause(r.retryAt, "AI usage limit reached");
    return;
  }
  const a = await outcome(run, r);
  await record(a);
  if (a.status === "needs" && run.host !== "visible")
    notify(`yolo:${a.key}`, "AutoApply needs you", `${a.company} – ${a.title}: ${a.reason}`);
  void pump();
}

/** The Applications entry a run's result makes. */
async function outcome(run: Run, r: YoloResult): Promise<Application> {
  const { item } = run;
  const previousKey = run.reviewKey ?? run.resumeKey;
  const previous = previousKey ? (await store.get("applications")).find((a) => a.key === previousKey) : undefined;
  return {
    key: previous?.key ?? (run.atsUrl ? jobKey(run.atsUrl) : item.key),
    alt: item.alt,
    url: run.atsUrl ?? applyUrl(item.url),
    company: item.company,
    title: item.title,
    location: item.location,
    source: item.source,
    sourceGroups: item.sourceGroups,
    ...(previous?.review ? { review: previous.review } : {}),
    ...(previous?.review && r.status === "submitted" ? { submittedBy: "user" as const } : {}),
    doneUrl: r.status === "submitted" ? r.doneUrl : "",
    mode: "yolo",
    status: r.status === "blocked" || r.status === "scraped" ? "failed" : r.status,
    reason: "reason" in r ? r.reason : "",
    guesses: mergeGuesses(mergeGuesses(previous?.guesses ?? [], run.guesses), "guesses" in r ? r.guesses : []),
    notes: [...new Set([...(previous?.notes ?? []), ...(run.notes ?? [])])],
    at: Date.now(),
  };
}

/** Save first, then stop driving, retaining the actual document and its uploads. */
async function holdForReview(run: Run, status: "review" | "needs", reason = "") {
  if (run.tabId === undefined || (await getRun())?.id !== run.id) return;
  const old = (await store.get("applications")).find((a) => a.key === (run.reviewKey ?? run.resumeKey));
  const key = old?.key ?? (run.atsUrl ? jobKey(run.atsUrl) : run.item.key);
  const reasons =
    old?.review?.reasons ?? reviewReasons(run.reviewPolicy ?? yolo.submissionReview, run.item, run.hasGuessedAnswers);
  const a: Application = {
    ...run.item,
    key,
    url: run.atsUrl ?? applyUrl(run.item.url),
    doneUrl: "",
    mode: "yolo",
    status,
    reason,
    guesses: mergeGuesses(old?.guesses ?? [], run.guesses),
    notes: [...new Set([...(old?.notes ?? []), ...(run.notes ?? [])])],
    review: {
      reasons: reasons.length ? reasons : ["Review preparation needs your help"],
      preparedAt: old?.review?.preparedAt || (status === "review" ? Date.now() : 0),
    },
    at: Date.now(),
  };
  await record(a);
  if (!(await end(run.id, true))) return;
  await releaseRealInput(run.tabId);
  await retainReview(key, run.tabId, run.documentId);
  const limit = deps.logLimit();
  if (limit) await logRun(run, { status: "needs", reason: reason || "Ready for your review" }, limit);
  await setState({ reviewUpdatedAt: Date.now() });
  void pump();
}

/** Debug logging: one entry per application with its steps, every field's answer, and what the page said at the end. */
async function logRun(run: Run, r: YoloResult, limit: number) {
  const answers = Object.values(run.answers ?? {});
  const up = await uploaded(run);
  const text = [
    `${r.status}: ${run.item.company} – ${run.item.title} (${run.host})`,
    run.atsUrl ?? run.item.url,
    `Steps: ${run.steps.map((s) => s.split("|")[0]).join(" → ") || "none"}`,
    "reason" in r && r.reason && `Reason: ${r.reason}`,
    run.confirmation && `Confirmation: ${run.confirmation}`,
    `Résumé: ${up.resume.join(", ") || "None"}`,
    `Cover letter: ${up.letter.join(", ") || "None"}`,
    `Answers (${answers.length}):`,
    ...answers.map((g) => `  ${g.q} = ${g.a}`),
  ]
    .filter(Boolean)
    .join("\n");
  const entry = { at: Date.now(), text, ...(up.files.length ? { files: up.files } : {}) };
  await store.set({ yoloLogs: [...(await store.get("yoloLogs")), entry].slice(-limit) });
}

type LogFile = { name: string; base64: string };

/** The résumés and cover letters the run uploaded, by name, and the files YOLO made for the job as uploaded. */
async function uploaded(run: Run) {
  const docs = await store.get("documentsIndex");
  const up = { resume: [] as string[], letter: [] as string[], files: [] as LogFile[] };
  for (const id of run.uploads ?? []) {
    if (isTailoredDoc(id) || isYoloDoc(id)) {
      const d = await (isYoloDoc(id) ? yoloDoc(id) : tailoredDoc(store, id));
      if (d) up.files.push({ name: d.meta.fileName, base64: d.base64 });
      if (isYoloDoc(id)) up.letter.push(`Generated (${d?.meta.fileName ?? "file no longer kept"})`);
      // The untailored PDF made when the .tex was uploaded, or a tailoring a browser restart lost.
      else up.resume.push(d && id !== FALLBACK ? `Tailored (${d.meta.fileName})` : "Untailored LaTeX résumé");
      continue;
    }
    const d = docs.find((x) => x.id === id);
    if (d?.kind === "resume") up.resume.push(d.label);
    else if (d?.kind === "cover_letter") up.letter.push(d.label);
  }
  return up;
}

async function watchdog(due: number) {
  const run = await getRun();
  if (!run) return void (await chrome.alarms.clear(WATCHDOG));
  const now = Date.now();
  // Fired late: the computer slept since `due`, which the run's time limits don't count.
  if (now - due > SLEPT_MS) {
    credit(run, due, now);
    await saveRun(run);
  }
  const late = overdue(run, now, yolo.reviewFills || yolo.aiNavigation ? REVIEW_RUN_MS : undefined);
  if (late) await finish(run, late);
  // After a worker restart the tab listener is gone: listen again.
  else if (run.host !== "frame") watchTab(run);
}

/** Opens an application that needs the user in a visible tab, where the run continues once they're done. */
async function resume(key: string): Promise<Responses["YOLO_RESUME"]> {
  const a = (await store.get("applications")).find((x) => x.key === key);
  if (!a) return { error: { kind: "other", message: "Unknown application" } };
  if (a.review) {
    if (!(await openReview(key))) {
      await queueReviewRefill(key);
      void pump();
    }
    return { ok: true };
  }
  const run = await getRun();
  if (run && (await end(run.id)) && run.mode === "apply") await requeue(run.item, run.resumeKey);
  await startResumed(a, "visible");
  return { ok: true };
}

async function startResumed(a: Application, host: "tab" | "visible") {
  const reviewing = !!a.review || a.status === "review";
  const policy = reviewing ? { ...yolo.submissionReview, mode: "all" as const } : yolo.submissionReview;
  const item = { ...a, listing: "", postedAt: 0, addedAt: Date.now() };
  await start(
    item,
    "apply",
    host,
    policy.mode === "off"
      ? undefined
      : { policy, key: reviewing ? a.key : undefined, tab: needsReviewTab(policy, item) },
    host === "tab" ? a.key : undefined,
  );
}

// ---------- page probes ----------
/** Self-contained (runs in the page): whether it confirms an application, by RE_APPLIED's source. */
const confirmed = (src: string) => (new RegExp(src, "i").test(document.body?.innerText ?? "") ? location.href : null);

const accountEmail = async () => yolo.email || (await store.get("profile")).personal.email;

/**
 * A YOLO run's job as its source listed it: a proper company name and title where the page offers only a slug
 * ("nuovophotography" on Workable), for essays and cover letters. Career sites' listings know no better than the page.
 */
export async function yoloJob(
  sender: chrome.runtime.MessageSender,
): Promise<{ company: string; title: string; location: string } | null> {
  const run = await getRun();
  if (!fromRun(run, sender) || run.mode !== "apply" || run.item.source === "careers") return null;
  return { company: run.item.company, title: run.item.title, location: run.item.location };
}

/** The run's tab as the rest of the background sees it; the hidden frame has none, so it stands in as tab -1. */
export async function runTab(sender: chrome.runtime.MessageSender): Promise<chrome.tabs.Tab | undefined> {
  if (sender.tab) return sender.tab;
  const run = await getRun();
  return fromRun(run, sender)
    ? ({ id: chrome.tabs.TAB_ID_NONE, url: run.atsUrl ?? run.item.url } as chrome.tabs.Tab)
    : undefined;
}

/** What a YOLO run's page fills with: nothing left for the user, the YOLO email, essays always drafted. */
export async function yoloOverrides(sender: chrome.runtime.MessageSender): Promise<{
  settings: Partial<Settings>;
  email: string;
  visible: boolean;
} | null> {
  const run = await getRun();
  if (!fromRun(run, sender)) return null;
  return {
    settings: {
      draftEssays: true,
      autoAcceptAcknowledgements: true,
      coverLetterPdfs: yolo.optionalCoverLetters,
      resumeUpload: yolo.resumeUpload,
      reviewFills: yolo.reviewFills,
      ...(run.host === "visible" ? {} : { showBadges: false }),
    },
    email: await accountEmail(),
    visible: run.host === "visible",
  };
}

/** For the warning on a manual fill: YOLO's submission for this posting, if any. */
export async function yoloApplied(url: string): Promise<{ at: number; url: string; byYou?: boolean } | undefined> {
  if (!yolo.warnOnYoloApplied || !url) return;
  const key = jobKey(url);
  const a = (await store.get("applications")).find(
    (x) => (x.mode === "yolo" || x.mode === "added") && x.status === "submitted" && x.key === key,
  );
  return a && { at: a.at, url: a.doneUrl || a.url, byYou: a.mode === "added" };
}

/** The job a YOLO run's page applies to and the steps it took, for the navigator; null for other pages. */
export async function yoloRunInfo(sender: chrome.runtime.MessageSender) {
  const run = await getRun();
  if (!fromRun(run, sender)) return null;
  return { company: run.item.company, title: run.item.title, steps: run.steps };
}

/**
 * A YOLO run's page is busy on a long AI call (the review of a filled page, the navigator): its step is making
 * progress, so the watchdog's "No progress for 3 minutes" waits.
 */
export async function yoloAlive(sender: chrome.runtime.MessageSender) {
  const run = await getRun();
  if (!fromRun(run, sender)) return;
  await saveRun({ ...run, stepAt: Date.now() });
}

/** Adds a note to the run's application record, when `sender` is a YOLO run's page. */
export async function yoloNote(sender: chrome.runtime.MessageSender, note: string) {
  const run = await getRun();
  if (!fromRun(run, sender) || run.mode !== "apply" || run.notes?.includes(note)) return;
  await saveRun({ ...run, notes: [...(run.notes ?? []), note] });
}

/** Debug logging: a document the run's page fetched to upload, for the run's log. */
export async function yoloUpload(sender: chrome.runtime.MessageSender, id: string) {
  if (!deps.logLimit()) return;
  const run = await getRun();
  if (!fromRun(run, sender) || run.mode !== "apply" || run.uploads?.includes(id)) return;
  await saveRun({ ...run, uploads: [...(run.uploads ?? []), id] });
}

export const isYoloDoc = (id: string) => id.startsWith("yolo-");
export const yoloDoc = (id: string) => session.get<{ meta: DocumentMeta; base64: string }>(`yolodoc:${id}`);

// ---------- messages ----------
export const yoloHandlers: { [T in Message["type"]]?: Handler<T> } = {
  async YOLO_STATUS() {
    const [apps, queue, state, run, alarm, check] = await Promise.all([
      store.get("applications"),
      store.get("yoloQueue"),
      store.get("yoloState"),
      getRun(),
      chrome.alarms.get(CHECK),
      store.get("yoloSourceCheck"),
    ]);
    return {
      enabled: yolo.enabled,
      searches: yolo.queries.length,
      appliedBatch: submittedSince(apps, state.batchAt),
      batchSize: yolo.batchSize,
      queued: queue.length,
      queueOnlyBatch: state.queueOnlyBatch,
      needsYou: apps.filter((a) => a.status === "needs").length,
      pendingReviews: apps.filter(pendingReview).length,
      preparedBatch: apps.filter((a) => a.review?.preparedAt && a.review.preparedAt >= state.batchAt).length,
      nextCheckAt: alarm?.scheduledTime ?? null,
      running: run?.mode === "apply" ? `${run.item.company} – ${run.item.title}` : null,
      paused: state.gmailNeedsAuth ? "Reconnect Gmail in Settings" : state.pauseReason,
      warnings: yolo.enabled
        ? [
            yolo.jobright.length && state.jobrightSignedOut ? "Jobright: sign in to jobright.ai in this browser" : "",
            yolo.boards.includes("indeed") && state.indeedSignedOut
              ? "Indeed: sign in to indeed.com in this browser"
              : "",
            // Signed out, Indeed isn't searched, so an older bot check says nothing current.
            yolo.boards.includes("indeed") && !state.indeedSignedOut && state.indeedBlocked
              ? "Indeed: showed a bot check. Tick it in the Indeed tab YOLO opened"
              : "",
          ].filter(Boolean)
        : [],
      sourceProblems:
        yolo.enabled && check?.doneAt
          ? check.groups.filter((g) => g.level === "warn" || g.level === "error").length
          : 0,
    };
  },

  async YOLO_SET({ enabled }) {
    const blocked = enabled ? await resumeBlocker() : "";
    if (blocked) return { error: { kind: "other", message: blocked } };
    if (enabled) await setState({ queueOnlyBatch: false });
    yolo = { ...yolo, enabled };
    await store.set({ yolo });
    // The new alarm's first firing, 30 s on, starts the first batch.
    await schedule();
    if (enabled) checking ??= checkSources().finally(() => (checking = null));
    return { ok: true };
  },

  async YOLO_CHECK_NOW() {
    void cycle();
    return { ok: true };
  },

  async YOLO_FORCE_BATCH() {
    if (!yolo.enabled || !yolo.queries.length)
      return { error: { kind: "other", message: "Turn on YOLO with a job search before starting a batch." } };
    await resetBatch();
    // The new budget takes effect even during discovery. Reuse that work and any application in flight;
    // otherwise discover for the batch just started, without moving its timestamp again.
    void cycle(true);
    return { ok: true };
  },

  async YOLO_APPLY_QUEUED() {
    if (!yolo.queries.length)
      return { error: { kind: "other", message: "Add a job search in YOLO settings before starting a batch." } };
    if (!yolo.batchSize)
      return { error: { kind: "other", message: "Set Applications per batch above 0 in YOLO settings." } };
    if (!(await store.get("yoloQueue")).length)
      return { error: { kind: "other", message: "No queued jobs to apply to." } };
    const blocked = await resumeBlocker();
    if (blocked) return { error: { kind: "other", message: blocked } };
    await resetBatch(true);
    if (!yolo.enabled) {
      yolo = { ...yolo, enabled: true };
      await store.set({ yolo });
      await schedule();
    }
    // Skip the turn-on source checks and discovery. pump still enforces all applying safeguards and limits.
    void pump();
    return { ok: true };
  },

  YOLO_RESUME: ({ key }) => resume(key),

  async YOLO_RESUME_PENDING() {
    const [apps, reviews, run] = await Promise.all([store.get("applications"), reviewList(), getRun()]);
    const handled = new Set([
      ...reviews.live,
      ...reviews.refilling,
      ...(run ? [run.item.key, run.reviewKey, run.resumeKey] : []),
    ]);
    const queued = await queuePendingResumes(
      apps.filter((a) => isPendingApplication(a) && !handled.has(a.key)).map((a) => a.key),
    );
    void pump();
    return { ok: true, queued };
  },

  async YOLO_REVIEW_LIST() {
    const list = await reviewList();
    const run = await getRun();
    list.refilling.push(...(await pendingResumeKeys()));
    if (run?.mode === "apply") list.refilling.push(run.reviewKey ?? run.resumeKey ?? run.item.key);
    return list;
  },
  async YOLO_REVIEW_OPEN({ key }) {
    return (await openReview(key))
      ? { ok: true }
      : {
          error: {
            kind: "other",
            message: "The filled tab is no longer available. Use Refill for review; earlier edits may be lost.",
          },
        };
  },
  async YOLO_REVIEW_REFILL({ key }) {
    if (!(await store.get("applications")).some((a) => a.key === key && pendingReview(a)))
      return { error: { kind: "other", message: "This application is no longer awaiting review." } };
    if ((await getRun())?.reviewKey !== key) await queueReviewRefill(key);
    void pump();
    return { ok: true };
  },
  async YOLO_REVIEW_DISMISS({ key }) {
    await dismissReview(key);
    return { ok: true };
  },
  async YOLO_REVIEW_MARK_SUBMITTED({ key }) {
    await submitReview(key);
    return { ok: true };
  },

  async YOLO_MARK_SUBMITTED({ key }) {
    const run = await getRun();
    if (run?.mode === "apply" && [run.item.key, run.reviewKey, run.resumeKey].includes(key)) await end(run.id, true);
    const a = await markApplicationSubmitted(key);
    if (!a) return { error: { kind: "other", message: "Unknown application" } };
    await releaseReview(key);
    await pendingResumeStarted(key);
    await updateQueue((q) => q.filter((i) => i.key !== key && i.listing !== key && (!a.alt || i.alt !== a.alt)));
    void pump();
    return { ok: true };
  },

  async YOLO_FORGET({ key }) {
    await releaseReview(key);
    await updateApplications((apps) => apps.filter((a) => a.key !== key));
    void pump();
    return { ok: true };
  },

  async YOLO_FORGET_FAILED() {
  async YOLO_ADD_APPLICATION({ job }) {
    const [url, company, title] = [job.url.trim(), job.company.trim(), job.title.trim()];
    const fail = (message: string) => ({ error: { kind: "other" as const, message } });
    // A site root or shared apply page would read as "already applied" for every job on that site.
    if (!/^https?:\/\//i.test(url) || !namesPosting(url)) return fail("Enter the link to the job posting itself.");
    if (!company || !title) return fail("Enter the company and job title.");
    const key = jobKey(url);
    const alt = altKey(company, title);
    let exists = false;
    await updateApplications((apps) => {
      exists = apps.some((a) => a.key === key);
      if (exists) return apps;
      const a: Application = {
        key,
        alt,
        url,
        company,
        title,
        location: "",
        source: "Added by you",
        doneUrl: "",
        mode: "added",
        status: "submitted",
        submittedBy: "user",
        reason: "",
        guesses: [],
        notes: [],
        at: Date.now(),
      };
      return [...apps, a];
    });
    if (exists) return fail("This job is already in Applications: use its Mark submitted button if it isn't marked.");
    // YOLO applying to it right now would submit it a second time.
    const run = await getRun();
    if (run?.mode === "apply" && (run.item.key === key || run.item.alt === alt)) await end(run.id);
    await updateQueue((q) => q.filter((i) => i.key !== key && i.listing !== key && i.alt !== alt));
    void pump();
    return { ok: true };
  },

    let failed: Application[] = [];
    // Use the current history and serialize with submissions so their records cannot be lost.
    await updateApplications((apps) => {
      failed = apps.filter((a) => a.status === "failed");
      return apps.filter((a) => a.status !== "failed");
    });
    for (const a of failed) if (a.review) await releaseReview(a.key);
    // Unchanged feeds must be read again so forgotten jobs can be rediscovered.
    if (failed.length) await store.set({ feedCache: {} });
    void pump();
    return { ok: true, forgotten: failed.length };
  },

  async YOLO_GMAIL_CONNECT() {
    try {
      await connectGmail(yolo, await accountEmail());
      await setState({ gmailNeedsAuth: false, gmailConnected: true });
      return { ok: true };
    } catch (e) {
      return { error: { kind: "other", message: (e as Error).message } };
    }
  },

  async YOLO_GMAIL_CHECK() {
    try {
      await checkGmail(yolo);
      await setState({ gmailNeedsAuth: false, gmailConnected: true });
    } catch (e) {
      // A network error says nothing about the sign-in: keep the last known state.
      if (!(e instanceof GmailAuthError)) return { ok: true };
      const { gmailConnected, gmailNeedsAuth } = await store.get("yoloState");
      await setState({ gmailConnected: false, gmailNeedsAuth: gmailNeedsAuth || gmailConnected });
    }
    return { ok: true };
  },

  async YOLO_ACCOUNTS() {
    return Object.entries(await store.get("vault")).map(([site, e]) => ({
      site,
      email: e.email,
      createdAt: e.createdAt,
    }));
  },

  async YOLO_REVEAL({ site }) {
    const a = await getAccount(site).catch(() => null);
    return a ? { password: a.password } : { error: { kind: "other", message: "Can't decrypt this password" } };
  },

  async YOLO_DELETE_ACCOUNT({ site }) {
    await deleteAccount(site);
    return { ok: true };
  },

  async YOLO_HELLO(_m, sender) {
    const run = await getRun();
    if (!fromRun(run, sender)) return null;
    const skipped = run.mode === "apply" && !run.helloAt && applyUrl(run.item.url) !== run.item.url;
    run.helloAt = run.stepAt = Date.now();
    run.documentId = sender.documentId;
    await saveRun(run);
    return {
      runId: run.id,
      submissionReview: run.reviewPolicy?.mode !== undefined && run.reviewPolicy.mode !== "off",
      mode: run.mode,
      company: run.item.company,
      title: run.item.title,
      visible: run.host === "visible",
      aiNavigation: yolo.aiNavigation,
      realInput: run.host !== "frame" && realInputReady() ? yolo.realInput : "off",
      ...(skipped ? { posting: run.item.url } : {}),
    };
  },

  async YOLO_STEP({ facts, url, guesses }, sender) {
    const run = await getRun();
    if (!fromRun(run, sender)) return { kind: "unknown", stop: "Not running" };
    // Without the tab retry, a bot check in the frame is the user's, like anywhere else.
    let kind = kindOf(facts, run.host === "frame" && yolo.tabFallback);
    let stop: string | undefined;
    // An emailed link must land back on the run's sites (a click tracker's destination is only known now). The browser
    // says where the page is, not the page.
    const landed = siteOfUrl(sender.url ?? url);
    if (run.linkSites && !run.linkSites.includes(landed)) stop = `The emailed link led to another site (${landed})`;
    run.linkSites = undefined;
    // Held after submitting (past a form step, not an account's verification): the page after the emailed link or
    // code confirms it, unless it says that failed.
    const held = run.confirming;
    if (kind === "verify" && confirmFirst(facts)) run.confirming ||= run.steps.some((s) => s.startsWith("form|"));
    else if (run.confirming && kind !== "verify" && kind !== "success") {
      if (verifyFailed(facts)) stop ??= "The emailed confirmation didn't go through";
      else kind = "success";
    }
    // Submitted: never applied to again after a browser restart.
    if (run.confirming && !held && run.host !== "visible")
      await store.set({ yoloInFlight: { ...run.item, submitted: true } });
    const sig = signature(kind, facts);
    run.guesses = mergeGuesses(run.guesses, guesses);
    // The page reloads to retry a submission flagged as spam: its steps repeat from the start, only the flags count.
    if (kind === "flagged") run.steps = run.steps.filter((s) => s.startsWith("flagged|"));
    if (run.steps.at(-1)?.startsWith("embedded|")) run.embedUrl ??= sender.url ?? url;
    run.steps.push(sig);
    run.stepAt = Date.now();
    if (kind === "success") run.confirmation = confirmation(facts);
    if (kind === "blocked" && run.host === "frame") {
      const hosts = (await store.get("yoloTabHosts")).filter((h) => h !== hostOf(url));
      await store.set({ yoloTabHosts: [...hosts, hostOf(url)].slice(-200) });
    }
    // Reached the employer's own posting from a board link: it may be one applied to through another source.
    if (
      !run.atsUrl &&
      /^(form|signin|signup)$/.test(kind) &&
      hostOf(url) !== hostOf(run.item.url) &&
      namesPosting(url)
    ) {
      run.atsUrl = url;
      if (
        applied(
          (await store.get("applications")).filter((a) => a.key !== (run.reviewKey ?? run.resumeKey)),
          jobKey(url),
          run.item.alt,
          yolo.reapplyManual,
        )
      )
        stop = "Already applied through another link";
    }
    if (run.steps.filter((s) => s === sig).length >= 3)
      stop = kind === "flagged" ? "The site kept flagging it as automated" : `Stuck at the same ${kind} step`;
    if (run.steps.length > 40) stop = "Too many steps";
    await saveRun(run);
    return {
      kind,
      refused: /^(signin|signup|reset)$/.test(kind) && refused(facts),
      // Turned down as a bot each time (a visible tab, the user's browser, usually passes), or already sent: the
      // user's to finish, never a failure.
      ...(stop ? { stop, needs: kind === "flagged" || !!run.confirming } : {}),
    };
  },

  async REAL_INPUT({ op }, sender) {
    const run = await getRun();
    const tabId = sender.tab?.id;
    const want = op.kind === "type" ? "typing" : "clicks";
    // Only the run's own tab, its top frame (whose viewport the points are in), and only what the setting allows.
    if (!fromRun(run, sender) || run.host === "frame" || tabId === undefined || sender.frameId !== 0)
      return { ok: false };
    if (yolo.realInput !== want && yolo.realInput !== "both") return { ok: false };
    return { ok: await realInput(tabId, op) };
  },

  async YOLO_RESULT({ result, runId }, sender) {
    const run = await getRun();
    if (
      fromRun(run, sender) &&
      (!runId || run.id === runId) &&
      (!run.documentId || run.documentId === sender.documentId)
    )
      await finish(run, result);
    return { ok: true };
  },

  async YOLO_BEFORE_SUBMIT({ runId, hasGuessedAnswers, guesses, ambiguous }, sender) {
    const run = await getRun();
    if (
      !fromRun(run, sender) ||
      run.id !== runId ||
      run.mode !== "apply" ||
      (run.host !== "frame" && (sender.frameId ?? 0) !== 0) ||
      (!!run.documentId && run.documentId !== sender.documentId)
    )
      return { action: "stop" };
    run.hasGuessedAnswers ||= hasGuessedAnswers;
    run.guesses = mergeGuesses(run.guesses, guesses);
    await saveRun(run);
    if (
      !run.reviewKey &&
      (!run.reviewPolicy || !reviewReasons(run.reviewPolicy, run.item, run.hasGuessedAnswers).length)
    )
      return { action: "submit" };
    if (run.tabId === undefined) return { action: "stop" };
    await holdForReview(
      run,
      ambiguous ? "needs" : "review",
      ambiguous ? "Check this action before continuing: it may submit the application." : "",
    );
    return { action: "held" };
  },

  async YOLO_ANSWERS({ answers, guesses, hasGuessedAnswers }, sender) {
    const run = await getRun();
    // A later pass over the same field (a refill) replaces its answer.
    if (fromRun(run, sender))
      await saveRun({
        ...run,
        answers: { ...run.answers, ...answers },
        guesses: mergeGuesses(run.guesses, guesses),
        hasGuessedAnswers: run.hasGuessedAnswers || hasGuessedAnswers,
      });
    return { ok: true };
  },

  async YOLO_CREDENTIAL({ site, create }, sender) {
    if (!fromRun(await getRun(), sender)) return null;
    if (!create) {
      const a = await getAccount(site).catch(() => null);
      return a && { ...a, created: false };
    }
    return { ...(await createAccount(site, await accountEmail())), created: true };
  },

  async YOLO_WAIT_EMAIL({ since, want }, sender) {
    const run = await getRun();
    if (!fromRun(run, sender)) return { error: { kind: "other", message: "Not running" } };
    const off = (message: string) => ({ error: { kind: "other" as const, message } });
    if (want === "code" && !yolo.emailCodes) return off("Emailed codes are off in YOLO settings");
    if (want === "link" && !yolo.verifyLinks) return off("Verification links are off in YOLO settings");
    // Only a link back to the run's sites: the page asking (the browser's record of it, not the page's word), the
    // employer's application site and the posting's.
    const asking = siteOfUrl(sender.url ?? "");
    if (want === "link" && !asking) return off("Unknown site");
    const sites = [asking, siteOfUrl(run.atsUrl ?? ""), siteOfUrl(run.item.url)].filter(Boolean);
    const email = await accountEmail();
    try {
      // No API client: codes can still come from the Gmail inbox signed in to this browser, links can't.
      if (!yolo.gmailClientId && want === "link") return off("Gmail isn't connected");
      const found = yolo.gmailClientId
        ? await waitForEmail(() => gmailToken(yolo), email, since, want, sites)
        : await waitForFeedCode(email, since);
      if (!found) return { error: { kind: "other", message: "No verification email arrived" } };
      if (want === "code") return { code: found };
      // Read minutes later: the run as it is now.
      const now = await getRun();
      if (now?.id !== run.id) return off("Not running");
      await saveRun({ ...now, linkSites: sites });
      return { link: found };
    } catch (e) {
      if (e instanceof GmailAuthError) {
        await setState({ gmailNeedsAuth: true, gmailConnected: false });
        notify(
          "yolo-gmail",
          "AutoApply: reconnect Gmail",
          "YOLO needs Gmail to verify new accounts. Open Settings → YOLO.",
        );
      }
      return { error: { kind: "other", message: (e as Error).message } };
    }
  },

  async COVER_LETTER_PDF({ question }, sender) {
    const tab = await runTab(sender);
    const ctx = await deps.serviceCtx("write");
    if ("error" in ctx) return ctx;
    const profile = await store.get("profile");
    const job = tab?.id !== undefined ? await getJobContext(tab.id) : null;
    const letter = await letterText(
      async (words) =>
        (
          await draftEssays(
            { ...ctx, settings: { ...ctx.settings, coverLetterDefaultWords: words } },
            [{ fieldId: "cl", question, kind: "cover_letter" }],
            profile,
            job,
          )
        )[0],
      ctx.settings.coverLetterDefaultWords,
      ctx.settings.coverLetterOnePage,
    );
    if ("error" in letter) return { error: { kind: "other", message: letter.error } };
    const id = `yolo-${crypto.randomUUID()}`;
    const base64 = textPdf(letter.text);
    const name = `${profile.personal.firstName} ${profile.personal.lastName}`.trim().replace(/\s+/g, "_") || "Cover";
    const meta: DocumentMeta = {
      id,
      label: "Cover letter (generated)",
      kind: "cover_letter",
      fileName: `${name}_Cover_Letter.pdf`,
      mimeType: "application/pdf",
      size: Math.floor((base64.length * 3) / 4),
      isPrimaryResume: false,
      uploadedAt: Date.now(),
    };
    await Promise.all([
      session.set(`yolodoc:${id}`, { meta, base64 }),
      // For the overlay: the job as draftEssays gave it to the AI.
      session.set(`docjob:${id}`, jobBrief(job) ?? {}),
    ]);
    return { meta };
  },

  async APPLY_ATTEMPT({ job, doneUrl }, sender) {
    if (await reviewAttempt(sender, doneUrl)) return { ok: true };
    const save = (done: string) =>
      record({
        key: jobKey(job.url),
        alt: altKey(job.company, job.title),
        url: job.url,
        company: job.company,
        title: job.title,
        location: "",
        source: "manual",
        doneUrl: done,
        mode: "manual",
        status: "submitted",
        reason: "",
        guesses: [],
        notes: [],
        at: Date.now(),
      });
    if (doneUrl) {
      await save(doneUrl);
      return { ok: true };
    }
    // The form navigated away before its page could confirm: look at the tab's next page once it has loaded.
    const tabId = sender.tab?.id;
    if (tabId !== undefined)
      setTimeout(async () => {
        const res = await chrome.scripting
          .executeScript({ target: { tabId, allFrames: true }, func: confirmed, args: [RE_APPLIED.source] })
          .catch(() => []);
        const done = res.map((x) => x.result).find(Boolean);
        if (done) await save(String(done));
      }, 6000);
    return { ok: true };
  },
};

export function initYolo(d: YoloDeps) {
  deps = d;
  let loaded = false;
  const ready = store.get("yolo").then(async (y) => {
    yolo = y;
    loaded = true;
    await initReviewTabs(() => {
      void setState({ reviewUpdatedAt: Date.now() }).then(() => pump());
    });
    await recoverLost();
    const run = await getRun();
    if (run?.mode === "apply") await pendingResumeStarted(run.resumeKey ?? run.item.key);
    if ((await reviewList()).refilling.length || (await pendingResumeKeys()).length) void pump();
  });
  store.onChange(["yolo"], (c) => {
    const prev = yolo;
    yolo = c.yolo ?? yolo;
    // A sign-in source just turned on (YOLO on or off): its settings note shows now, not at the next turn-on or batch.
    // Before the settings load, `prev` is the defaults, so every source that's on is checked.
    const turnedOn = (on: (y: Yolo) => boolean) => on(yolo) && (!loaded || !on(prev));
    const jobright = turnedOn((y) => y.jobright.length > 0);
    const indeed = turnedOn((y) => y.boards.includes("indeed"));
    if (jobright || indeed) void checkSignIns({ jobright, indeed });
    // New searches: re-read the feeds in full at the next check, not only what changed since the last one.
    const search = (y: Yolo) => JSON.stringify([y.queries, y.locations, y.remoteOk, y.excludeTitleWords, y.feeds]);
    if (search(prev) !== search(yolo)) void store.set({ feedCache: {} });
    void schedule().then(() => pump());
  });
  chrome.alarms.onAlarm.addListener(
    (a) =>
      void ready.then(async () => {
        // Fired late, the computer just woke: the network may not be back yet.
        if (a.name === CHECK)
          await (Date.now() - a.scheduledTime > SLEPT_MS || !navigator.onLine ? whenOnline("check") : cycle());
        else if (a.name === WATCHDOG) await watchdog(a.scheduledTime);
        else if (a.name.startsWith(`${ONLINE}|`)) await online(a.name);
        else if (a.name === RESUME) {
          await setState({ pausedUntil: 0, pauseReason: "" });
          await pump();
        }
      }),
  );
  chrome.notifications.onClicked.addListener((id) => {
    chrome.notifications.clear(id);
    if (id.startsWith("yolo:")) void ready.then(() => resume(id.slice(5)));
    else if (id === INDEED_NOTE && indeedTabId !== undefined)
      void chrome.tabs
        .update(indeedTabId, { active: true })
        .then((t) => t && chrome.windows.update(t.windowId, { focused: true }))
        .catch(() => undefined);
    else if (id === "yolo-gmail")
      void chrome.tabs.create({ url: chrome.runtime.getURL("src/options/index.html#/yolo") });
  });
  return ready;
}
