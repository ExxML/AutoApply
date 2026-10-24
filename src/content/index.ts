// Content script: per-frame bootstrap (§11.1), fill pipeline (§12), learning (§16.3) and status reporting.
// Fills only when the user triggers it. Never sees API keys; never clicks submit/next.
import { RE_CONSENT, RE_COVER_LETTER, RE_OPTIONAL_CONSENT, RE_RESUME_ONLY } from "../shared/constants";
import { parseEssayLimits, wordCount } from "../shared/essay";
import { isErr, send, type Message } from "../shared/messages";
import type {
  ApiError,
  Decision,
  EssayItem,
  FieldDescriptor,
  FrameStatus,
  NeedsYouItem,
  RuntimeConfig,
  StatusCounts,
} from "../shared/types";
import { extractJobContext } from "./jobContextExtract";
import { deterministicValue, isFreeText, matchLearned } from "./match/deterministic";
import { localMatchAll } from "./match/localMatch";
import { harvestOptions } from "./fill/dropdown";
import { fill, serial, type FillOp } from "./fill/engine";
import { isFilling, sleep, waitFor } from "./fill/events";
import { findDropzones } from "./fill/file";
import { addEntries, saveEntries } from "./fill/sections";
import { readValue } from "./fill/verify";
import { consentPair, newScanState, scan, yesNoPair, type FieldHandle } from "./scan/fields";
import { removeBadge, setBadge, setBadgesVisible, type BadgeColor } from "./ui/badges";
import { showLearnPrompt } from "./ui/learnPrompt";
import { createOverlay, type Overlay } from "./ui/overlay";
import { claimFrame, relayClicksToTop } from "./ui/root";

type Status =
  | "pending"
  | "working"
  | "filled"
  | "ai"
  | "draft"
  | "needs"
  | "check"
  | "failed"
  | "prefilled"
  | "skipped"
  | "you"
  | "saved"
  | "edited";

interface FieldState {
  status: Status;
  note?: string;
  tooltip?: string;
  userOwned?: boolean;
  /** Was flagged/failed, or AI-filled then changed by the user → eligible for the learning prompt. */
  learnable?: boolean;
  /** Field value when the status was last set; a different value later means the user changed it. */
  value?: string;
}

const BADGE: Partial<Record<Status, [BadgeColor, string]>> = {
  filled: ["green", "✓"],
  you: ["green", "You"],
  saved: ["green", "Saved"],
  ai: ["blue", "AI"],
  draft: ["purple", "AI draft"],
  needs: ["yellow", "Needs you"],
  check: ["orange", "Check"],
  failed: ["red", "Failed"],
};

const TOP = window === window.top;
const HOST = location.hostname;

let config: RuntimeConfig;
const scanState = newScanState();
const handles = new Map<string, FieldHandle>();
const states = new Map<string, FieldState>();
const checkedByUs = new Set<Element>();
const harvested = new Map<string, string[]>();
let current: { groupId: string; ctrl: AbortController } | null = null;
let running = false;
let queued: { rerun: boolean; depth?: number } | null = null;
/** Save buttons of entry editors addEntries opened, clicked after the last fill pass. */
const unsaved: HTMLElement[] = [];
let lastError: ApiError | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let timings: [string, number][] = [];
let usedModel: string | null = null;
let overlay: Overlay | null = null;
/** Top frame: a triggered fill found no fields here, and no child frame reported any either. */
let noForm = false;
const NO_FORM: ApiError = { kind: "other", message: "No job application form found on this page." };
const childFrames = new Map<number, FrameStatus>();
/** Aborted when a newer instance (extension reload/update) takes over this frame. */
const life = new AbortController();

// ---------- status ----------
function counts(): StatusCounts {
  const c: StatusCounts = {
    total: 0,
    filled: 0,
    aiMatched: 0,
    aiDrafted: 0,
    needsYou: 0,
    failed: 0,
    prefilled: 0,
    skipped: 0,
  };
  for (const s of states.values()) {
    c.total++;
    if (["filled", "ai", "draft", "check", "you", "saved", "edited"].includes(s.status)) c.filled++;
    if (s.status === "ai") c.aiMatched++;
    if (s.status === "draft") c.aiDrafted++;
    if (s.status === "needs") c.needsYou++;
    if (s.status === "failed") c.failed++;
    if (s.status === "prefilled") c.prefilled++;
    if (s.status === "skipped") c.skipped++;
  }
  return c;
}

function frameStatus(): FrameStatus {
  const needsYou: NeedsYouItem[] = [];
  for (const [id, s] of states)
    if (s.status === "needs" || s.status === "failed")
      needsYou.push({ fieldId: id, label: handles.get(id)?.desc.label ?? "", note: s.note ?? "" });
  return { frameId: 0, counts: counts(), needsYou, running, error: lastError?.message };
}

let reportTimer: ReturnType<typeof setTimeout> | undefined;
function report() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = undefined;
    const st = frameStatus();
    send({ type: "FRAME_STATUS", status: st }).catch(() => undefined);
    if (TOP) renderOverlay();
  }, 250);
}

function renderOverlay() {
  const own = frameStatus();
  const frames = [own, ...childFrames.values()].filter((f) => f.counts.total || f.running || f.error);
  const childError = [...childFrames.values()].find((f) => f.error)?.error;
  const error =
    lastError ?? (childError ? { kind: "other", message: childError } : !frames.length && noForm ? NO_FORM : null);
  if (!frames.length && !error) return;
  overlay ??= createOverlay(
    {
      onRerun: () => void send({ type: "BROADCAST_FILL", rerun: true }),
      onStop: stop,
      onRetry: () => void send({ type: "BROADCAST_FILL", rerun: true }),
      onOpenSettings: () => void send({ type: "OPEN_OPTIONS", hash: "/ai" }),
      onFocus: (n) =>
        n.frameId ? void send({ type: "FOCUS_FIELD", frameId: n.frameId, fieldId: n.fieldId }) : focusField(n.fieldId),
      onMove: (bottom) => void send({ type: "SET_OVERLAY_POS", host: HOST, bottom }),
    },
    config?.overlayBottom ?? null,
  );
  const total: StatusCounts = {
    total: 0,
    filled: 0,
    aiMatched: 0,
    aiDrafted: 0,
    needsYou: 0,
    failed: 0,
    prefilled: 0,
    skipped: 0,
  };
  for (const f of frames) for (const k of Object.keys(total) as (keyof StatusCounts)[]) total[k] += f.counts[k];
  overlay.update({
    counts: total,
    needsYou: frames.flatMap((f) => f.needsYou.map((n) => ({ ...n, frameId: f.frameId }))),
    running: frames.some((f) => f.running),
    error,
    model: usedModel ?? config?.selectedModel ?? null,
    debug: config?.settings.debugLogging ? timings.map(([k, v]) => `${k.padEnd(10)} ${v} ms`).join("\n") : "",
  });
}

function setStatus(h: FieldHandle, status: Status, note?: string, tooltip?: string) {
  const s = states.get(h.id) ?? { status };
  s.status = status;
  s.note = note;
  s.tooltip = tooltip;
  if (status === "needs" || status === "failed") s.learnable = true;
  if (status !== "pending" && status !== "working") s.value = readValue(h);
  states.set(h.id, s);
  const b = BADGE[status];
  if (b && config.settings.showBadges) {
    const onClick = status === "draft" ? () => offerLearn(h, "Save as reusable answer?") : undefined;
    setBadge(h.id, h.container, b[0], b[1], [note, tooltip].filter(Boolean).join(" — ") || b[1], onClick, h.desc.label);
  } else removeBadge(h.id);
  report();
}

// ---------- helpers ----------
function focusField(id: string) {
  const h = handles.get(id);
  const target = h?.members?.[0] ?? h?.searchInput ?? h?.el;
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  target?.focus?.({ preventScroll: true });
}

function stop() {
  if (!current) return;
  current.ctrl.abort();
  void send({ type: "ABORT", groupId: current.groupId });
  for (const [id, s] of states) if (s.status === "working") setStatus(handles.get(id)!, "needs", "Stopped");
}

function primaryDocFor(h: FieldHandle): string | null | undefined {
  const text = `${h.desc.label} ${h.desc.hint ?? ""}`;
  const docs = config.documentsIndex;
  if (RE_COVER_LETTER.test(text)) return docs.find((d) => d.kind === "cover_letter")?.id ?? null;
  if (RE_RESUME_ONLY.test(text))
    return (docs.find((d) => d.isPrimaryResume) ?? docs.find((d) => d.kind === "resume"))?.id ?? null;
  return undefined; // not a résumé/cover-letter field: ask the AI
}

function opFromDecision(h: FieldHandle, d: Decision): FillOp | null {
  const k = h.desc.kind;
  if (k === "file") {
    const id = d.documentId ?? primaryDocFor(h);
    return id ? { type: "file", documentId: id } : null;
  }
  if (k === "checkbox") return d.checked === undefined ? null : { type: "checked", value: d.checked };
  const options = h.desc.options ?? harvested.get(h.id);
  if (d.optionIndexes?.length && options) return { type: "options", texts: d.optionIndexes.map((i) => options[i]) };
  if (k === "dropdown" || k === "typeahead") {
    const answer = d.intendedAnswer ?? d.text;
    return answer ? { type: "intended", answer, query: d.searchQuery } : null;
  }
  if (isFreeText(k)) {
    const value = d.text ?? d.intendedAnswer;
    return value ? { type: "text", value } : null;
  }
  const answer = d.intendedAnswer ?? d.text;
  return answer ? { type: "intended", answer, query: d.searchQuery } : null;
}

// ---------- choose-options batching (§14.6 step 3) ----------
const chooseQueue: {
  item: { fieldId: string; question: string; intendedAnswer: string; options: string[]; multiple: boolean };
  resolve: (v: number[] | null) => void;
}[] = [];
let chooseBusy = false;
function choose(h: FieldHandle, intended: string, options: string[]): Promise<number[] | null> {
  return new Promise((resolve) => {
    chooseQueue.push({
      item: { fieldId: h.id, question: h.desc.label, intendedAnswer: intended, options, multiple: !!h.desc.multiple },
      resolve,
    });
    void drainChoose();
  });
}
async function drainChoose() {
  if (chooseBusy) return;
  chooseBusy = true;
  await sleep(0);
  while (chooseQueue.length) {
    const batch = chooseQueue.splice(0, 20);
    const r = await send({
      type: "CHOOSE_OPTIONS",
      items: batch.map((b) => b.item),
      groupId: current?.groupId ?? "",
    }).catch(() => null);
    for (const b of batch) {
      const c = r && !isErr(r) ? r.choices.find((x) => x.fieldId === b.item.fieldId) : null;
      b.resolve(c?.optionIndexes ?? null);
    }
  }
  chooseBusy = false;
}

// ---------- pipeline (§12) ----------
function rescan(): FieldHandle[] {
  const { handles: hs } = scan(scanState);
  const all = [...hs, ...findDropzones(hs, scanState)];
  for (const h of all) {
    // Dropzone.js (Teamtailor) swaps in a new hidden input after each upload: it is the same, uploaded field.
    const old =
      h.desc.kind === "file" && !states.has(h.id)
        ? [...handles.values()].find(
            (o) => o.desc.kind === "file" && o.desc.label === h.desc.label && !o.el.isConnected && states.has(o.id),
          )
        : undefined;
    if (old) states.set(h.id, states.get(old.id)!);
    handles.set(h.id, h);
  }
  return all;
}

/**
 * Chrome stops rendering a cross-origin frame that lies wholly outside the viewport, so its dropdowns never open
 * (Riot's Greenhouse form, far below the job description): scroll the frame into view first. Its viewport size, stale
 * meanwhile (150 px for Riot's 6582 px frame), updates some 100 ms after it shows; fills before that still fail.
 */
async function revealFrame() {
  const root = document.documentElement;
  const seen = await new Promise<boolean>((resolve) => {
    const io = new IntersectionObserver(([e]) => {
      io.disconnect();
      resolve(e.isIntersecting);
    });
    io.observe(root);
    void sleep(300).then(() => resolve(true));
  });
  if (seen) return;
  const stale = innerHeight;
  root.scrollIntoView({ block: "start" });
  await waitFor(() => innerHeight !== stale, 1000);
}

/** The last fill applied to each field, to re-apply as is if the page empties it. */
const applied = new Map<string, [FillOp, Status, string]>();

async function doFill(h: FieldHandle, op: FillOp, okStatus: Status, tooltip: string, ctrl: AbortController) {
  if (states.get(h.id)?.userOwned) return;
  applied.set(h.id, [op, okStatus, tooltip]);
  setStatus(h, "working");
  const r = await fill(h, op, {
    documents: config.documentsIndex,
    getDocument: (id) => send({ type: "GET_DOCUMENT", id }),
    choose,
    checkedByUs,
    harvested,
    signal: ctrl.signal,
  });
  if (states.get(h.id)?.userOwned) return;
  if (r.outcome === "ok") {
    setStatus(h, okStatus, r.note, okStatus === "ai" && r.shown ? `${tooltip} → "${r.shown}"` : tooltip);
  } else if (r.outcome === "mismatch") setStatus(h, "check", r.note, tooltip);
  else if (r.outcome === "failed") setStatus(h, "failed", r.note);
  else setStatus(h, "needs", r.note);
}

/** Required and optional consents follow separate settings; a required field is never optional. */
function handleConsent(h: FieldHandle, d: Decision | undefined, ctrl: AbortController, jobs: Promise<void>[]) {
  const optional =
    !h.desc.required && (d?.checked === false || RE_OPTIONAL_CONSENT.test(`${h.desc.label} ${h.desc.hint ?? ""}`));
  const { optionalConsents, autoAcceptAcknowledgements } = config.settings;
  const mode = optional ? optionalConsents : autoAcceptAcknowledgements ? "accept" : "ask";
  const accept = mode === "accept";
  // Choice fields: [consenting option, declining option], from the AI or read locally from the options.
  const options = h.desc.options ?? harvested.get(h.id);
  // The AI may answer "consent" without naming the two options (Ramp's SMS question): read them locally then.
  // A lone option (Reddit's "I agree" dropdown) can only accept; plain "Yes"/"No" (MongoDB's job alerts) pair too.
  const pair =
    d?.optionIndexes?.length === 2
      ? d.optionIndexes
      : ((options && (consentPair(options) ?? yesNoPair(options))) ?? (options?.length === 1 ? [0] : d?.optionIndexes));
  const pick = options?.[pair?.[accept ? 0 : 1] ?? -1];
  // A box per consent (Gemini: privacy statement + background check): tick each one that isn't an optional extra.
  const boxes =
    h.desc.kind === "checkbox_group" &&
    accept &&
    options?.every((o) => RE_CONSENT.test(o) || RE_OPTIONAL_CONSENT.test(o))
      ? options.filter((o) => optional || optionalConsents === "accept" || !RE_OPTIONAL_CONSENT.test(o))
      : [];
  const op: FillOp | null =
    h.desc.kind === "checkbox"
      ? { type: "checked", value: accept }
      : boxes.length
        ? { type: "options", texts: boxes }
        : pick
          ? { type: "options", texts: [pick] }
          : null;
  const tooltip = `${accept ? "Auto-accepted" : "Auto-declined"}${optional ? " (optional)" : ""}`;
  if (mode !== "ask" && op) jobs.push(doFill(h, op, "ai", tooltip, ctrl));
  else setStatus(h, "needs", "Needs your confirmation");
}

/** Filled by us, then emptied by the page itself. Not uploads: re-uploading a résumé re-runs its parser. */
function emptied(h: FieldHandle): boolean {
  const s = states.get(h.id);
  return (
    !!s?.value &&
    !s.userOwned &&
    applied.has(h.id) &&
    h.desc.kind !== "file" &&
    ["filled", "ai", "draft", "check"].includes(s.status) &&
    h.el.isConnected &&
    !readValue(h)
  );
}

async function runPipeline(opts: { rerun?: boolean; depth?: number } = {}) {
  if (running) {
    queued = { rerun: !!opts.rerun || !!queued?.rerun };
    return;
  }
  running = true;
  document.dispatchEvent(new Event("autoapply-fill-start")); // see pageTimers.ts
  lastError = null;
  clearTimeout(retryTimer);
  const ctrl = new AbortController();
  const groupId = crypto.randomUUID();
  current = { groupId, ctrl };
  const t0 = performance.now();
  timings = [];
  const mark = (k: string) => timings.push([k, Math.round(performance.now() - t0)]);
  const jobs: Promise<void>[] = [];
  try {
    config = await send({ type: "GET_RUNTIME_CONFIG" });
    setBadgesVisible(config.settings.showBadges);
    unsaved.push(...(await addEntries(config.entryCounts, ctrl.signal)));
    const all = rescan();
    mark("scan");
    const targets = all.filter((h) => {
      const s = states.get(h.id);
      if (s?.userOwned) return false;
      if (!s || s.status === "pending") return true;
      return !!opts.rerun && ["needs", "failed", "check"].includes(s.status);
    });
    for (const h of targets) setStatus(h, "pending");
    report();
    if (!TOP && targets.length) await revealFrame();

    // Job context: top frame extracts; child frames share theirs only when they hold a description.
    const jc = extractJobContext();
    if (TOP || jc.text) await send({ type: "SET_JOB_CONTEXT", ctx: jc });

    // PHASE A: deterministic and learned answers — no network to Gemini.
    const det = config.profileSnapshotForDeterministic;
    const usedLearned: string[] = [];
    const pending: FieldHandle[] = [];
    for (const h of targets) {
      if (h.prefilled && !config.settings.overwritePrefilled) {
        setStatus(h, "prefilled");
        continue;
      }
      if (h.sensitive) {
        setStatus(h, "needs", "Sensitive – fill manually");
        continue;
      }
      if (h.consent) {
        handleConsent(h, undefined, ctrl, jobs);
        continue;
      }
      if (h.desc.kind === "file") {
        const doc = primaryDocFor(h);
        if (doc) jobs.push(doFill(h, { type: "file", documentId: doc }, "filled", "Primary résumé", ctrl));
        else if (doc === null)
          setStatus(h, "needs", RE_COVER_LETTER.test(h.desc.label) ? "No cover letter uploaded" : "No résumé uploaded");
        else pending.push(h);
        continue;
      }
      const d = deterministicValue(h.desc, det.personal);
      if (d) {
        const op: FillOp = d.query
          ? { type: "intended", answer: d.value, query: d.query }
          : { type: "text", value: d.value };
        if (d.value) jobs.push(doFill(h, op, "filled", d.path, ctrl));
        else setStatus(h, "needs", "Not set in your Profile");
        continue;
      }
      const l = matchLearned(h.desc, det.learnedAnswers);
      if (l) {
        let op: FillOp | null = null;
        if (isFreeText(h.desc.kind)) op = { type: "text", value: l.answer };
        else if (h.desc.kind === "checkbox") op = { type: "checked", value: /^(true|yes|checked)$/i.test(l.answer) };
        else if (h.desc.options) {
          const idx = localMatchAll(l.answer, h.desc.options);
          if (idx) op = { type: "options", texts: idx.map((i) => h.desc.options![i]) };
        } else op = { type: "intended", answer: l.answer };
        if (op) {
          usedLearned.push(l.id);
          jobs.push(doFill(h, op, "filled", "Saved answer", ctrl));
          continue;
        }
      }
      pending.push(h);
    }
    if (usedLearned.length) void send({ type: "LEARNED_USED", ids: usedLearned });
    mark("phaseA");

    // PHASE B: batched mapping calls (chunked in the background). Dropdowns with unknown options are harvested
    // first and mapped in a second call, so the AI picks from the real options instead of guessing blind.
    if (pending.length && !ctrl.signal.aborted) {
      for (const h of pending) setStatus(h, "working");
      const toHarvest = pending.filter((h) => h.desc.kind === "dropdown" && !h.desc.optionsKnown).slice(0, 15);
      const later = new Set(toHarvest);
      const now = pending.filter((h) => !later.has(h));
      const essays: EssayItem[] = [];
      const harvestThenMap = async () => {
        for (const h of toHarvest)
          await serial(async () => {
            if (ctrl.signal.aborted || harvested.has(h.id)) return;
            const opts = await harvestOptions(h, 400);
            if (opts) harvested.set(h.id, opts);
          });
        const fields = toHarvest.map((h) => {
          const options = harvested.get(h.id);
          return options ? { ...h.desc, options, optionsKnown: true } : h.desc;
        });
        await mapAndApply(toHarvest, fields);
      };
      const mapAndApply = async (hs: FieldHandle[], fields: FieldDescriptor[]) => {
        if (!hs.length || ctrl.signal.aborted) return;
        const res = await send({ type: "MAP_FIELDS", fields, host: HOST, groupId });
        if (isErr(res)) {
          lastError = res.error;
          for (const h of hs) setStatus(h, "needs", res.error.message);
          scheduleAutoRetry(res.error);
          return;
        }
        usedModel = res.usedModel;
        for (const d of res.decisions) {
          const h = handles.get(d.fieldId);
          if (!h || states.get(h.id)?.userOwned) continue;
          const suggestion = d.suggestion ? `Suggested: ${d.suggestion}` : undefined;
          if (d.action === "fill") {
            const op = opFromDecision(h, d);
            if (op) jobs.push(doFill(h, op, "ai", (d.sources ?? []).join(", ") || "AI", ctrl));
            else setStatus(h, "needs", d.note ?? "No usable AI answer", suggestion);
          } else if (d.action === "essay") {
            if (config.settings.draftEssays) {
              const limits = parseEssayLimits(h.desc.label, h.desc.hint, h.desc.maxLength);
              const kind = RE_COVER_LETTER.test(h.desc.label) ? "cover_letter" : "essay";
              essays.push({ fieldId: h.id, question: h.desc.label, hint: h.desc.hint, ...limits, kind });
            } else setStatus(h, "needs", "Write this yourself");
          } else if (d.action === "consent") handleConsent(h, d, ctrl, jobs);
          else if (d.action === "skip") setStatus(h, "skipped");
          else setStatus(h, "needs", d.note ?? "AI could not answer", suggestion);
        }
      };
      const fieldsNow = now.map((h) => h.desc);
      await Promise.all([mapAndApply(now, fieldsNow), harvestThenMap()]);
      mark("map");
      if (essays.length) jobs.push(draftEssays(essays, groupId, ctrl, mark));
    }
    await Promise.all(jobs);
    mark("done");
    // Résumé parsers (SmartRecruiters) re-render the form, emptying fields filled before: re-apply those answers.
    // Answers can also reveal follow-up questions (Greenhouse: Hispanic/Latino "No" → race): fill them in another pass.
    const depth = opts.depth ?? 0;
    if (!ctrl.signal.aborted && depth < 2) {
      const fresh = rescan();
      await Promise.all(fresh.filter(emptied).map((h) => doFill(h, ...applied.get(h.id)!, ctrl)));
      if (fresh.some((h) => !states.has(h.id))) queued ??= { rerun: false, depth: depth + 1 };
    }
    // Entry editors we opened (SmartRecruiters' Experience) are saved once nothing more will be filled in them.
    if (!queued && !ctrl.signal.aborted && unsaved.length) await saveEntries(unsaved.splice(0));
  } catch (e) {
    lastError = { kind: "other", message: (e as Error)?.message ?? String(e) };
  } finally {
    running = false;
    document.dispatchEvent(new Event("autoapply-fill-end"));
    current = null;
    report();
    // Child frames report their fields ~250 ms after the trigger; give them time before calling the page empty.
    if (TOP && !states.size)
      setTimeout(() => {
        noForm = true;
        renderOverlay();
      }, 1000);
    if (queued) {
      const q = queued;
      queued = null;
      void runPipeline(q);
    }
  }
}

async function draftEssays(items: EssayItem[], groupId: string, ctrl: AbortController, mark: (k: string) => void) {
  for (const i of items) setStatus(handles.get(i.fieldId)!, "working", "Drafting…");
  const r = await send({ type: "DRAFT_ESSAYS", items, groupId });
  if (isErr(r)) {
    for (const i of items) setStatus(handles.get(i.fieldId)!, "needs", r.error.message);
    return;
  }
  await Promise.all(
    r.essays.map(async (e) => {
      const h = handles.get(e.fieldId);
      if (!h || states.get(h.id)?.userOwned || ctrl.signal.aborted) return;
      if (!e.text) return setStatus(h, "needs", e.note ?? "No draft");
      const fr = await fill(
        h,
        { type: "text", value: e.text },
        {
          documents: [],
          getDocument: async () => null,
          choose,
          checkedByUs,
          harvested,
          signal: ctrl.signal,
        },
      );
      if (states.get(h.id)?.userOwned) return;
      if (fr.outcome === "ok") setStatus(h, "draft", "AI draft – review", `${wordCount(e.text)} words`);
      else setStatus(h, fr.outcome === "mismatch" ? "check" : "failed", fr.note);
    }),
  );
  mark("essays");
}

function scheduleAutoRetry(err: ApiError) {
  if (err.kind !== "allKeysExhausted" || !err.earliestRetryAt) return;
  const wait = err.earliestRetryAt - Date.now();
  if (wait > 0 && wait <= 90_000) retryTimer = setTimeout(() => void runPipeline({ rerun: true }), wait + 250);
}

// ---------- user edits & learning (§12 cancellation, §16.3) ----------
function handleFor(t: EventTarget | null): FieldHandle | null {
  if (!(t instanceof Node)) return null;
  for (const h of handles.values())
    if (
      h.el.contains(t) ||
      h.members?.some((m) => m === t || m.contains(t) || (m as HTMLInputElement).labels?.[0]?.contains(t))
    )
      return h;
  return null;
}

function onUserInput(e: Event) {
  if (!e.isTrusted || isFilling()) return;
  const h = handleFor(e.composedPath()[0] ?? e.target);
  if (!h) return;
  const s = states.get(h.id) ?? { status: "pending" as Status };
  s.userOwned = true;
  states.set(h.id, s);
  if (s.status === "ai" || s.status === "filled" || s.status === "check" || s.status === "draft") {
    s.learnable = s.status !== "draft";
    setStatus(h, "edited");
  }
}

function offerLearn(h: FieldHandle, title?: string) {
  const answer = readValue(h);
  if (!answer) return;
  showLearnPrompt(
    h.container,
    h.desc.label,
    answer,
    async () => {
      await send({
        type: "SAVE_LEARNED_ANSWER",
        answer: { question: h.desc.label, kind: h.desc.kind, options: h.desc.options, answer, host: HOST },
      });
      setStatus(h, "saved", "Saved for future applications");
    },
    title,
  );
}

function onUserCommit(e: Event) {
  if (!e.isTrusted || isFilling()) return;
  const h = handleFor(e.composedPath()[0] ?? e.target);
  if (!h) return;
  // Choice clicks (radios, pill buttons, dropdown options) settle after the page's own handlers run.
  setTimeout(() => {
    const s = states.get(h.id);
    if (!s || s.status === "working") return;
    const value = readValue(h);
    if (value === (s.value ?? "")) return;
    s.userOwned = true;
    if (s.status === "ai" || s.status === "filled" || s.status === "check") {
      s.learnable = true;
      setStatus(h, "edited");
    } else if (s.status === "draft") setStatus(h, "edited");
    else s.value = value;
    if (!value) return;
    if (s.status === "needs" || s.status === "failed") setStatus(h, "you", "You answered this");
    if (config.settings.learnPrompts && s.learnable && h.desc.kind !== "file") offerLearn(h);
  }, 50);
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (!config) return false;
  switch (msg.type) {
    case "TRIGGER_FILL":
      void runPipeline({ rerun: msg.rerun ?? msg.force });
      break;
    case "FOCUS_FIELD":
      focusField(msg.fieldId);
      break;
    case "TOGGLE_OVERLAY":
      overlay?.toggle();
      break;
    case "FRAME_STATUS":
      if (TOP) {
        childFrames.set(msg.status.frameId, msg.status);
        renderOverlay();
      }
      break;
    default:
      return false;
  }
  sendResponse({ ok: true });
  return false;
});

// ---------- bootstrap (§11.1) ----------
async function main() {
  if (!TOP) relayClicksToTop(life.signal); // before the bail-outs: about:blank editor frames are outside clicks too
  if (!/^https?:$/.test(location.protocol) || !document.body) return;
  const g = globalThis as { __autoapply?: boolean };
  if (g.__autoapply) return;
  g.__autoapply = true;
  claimFrame(() => {
    life.abort();
    current?.ctrl.abort(); // no ABORT message: this context's runtime is gone
    queued = null;
    clearTimeout(retryTimer);
  });
  try {
    config = await send({ type: "GET_RUNTIME_CONFIG" });
  } catch {
    return; // extension context gone (reloaded)
  }
  if (config.excluded || config.settings.excludedHosts.includes(HOST)) return;

  const opts = { capture: true, signal: life.signal };
  document.addEventListener("input", onUserInput, opts);
  for (const ev of ["change", "focusout", "click"]) document.addEventListener(ev, onUserCommit, opts);
  // A page timer set during a fill in a hidden tab (pageTimers.ts): fire it on time.
  document.addEventListener(
    "autoapply-timer",
    (e) => {
      const [id, ms] = String((e as CustomEvent<string>).detail).split(":");
      void sleep(Number(ms)).then(() =>
        document.dispatchEvent(new CustomEvent("autoapply-timer-fire", { detail: id })),
      );
    },
    opts,
  );
}

void main();
