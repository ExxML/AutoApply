// Content script: per-frame bootstrap (§11.1), fill pipeline (§12), SPA/multi-step handling (§11.8),
// learning (§16.3) and status reporting. Never sees API keys; never clicks submit/next.
import { RE_COVER_LETTER, RE_RESUME_ONLY } from "../shared/constants";
import { parseEssayLimits, wordCount } from "../shared/essay";
import { isErr, send, type Message } from "../shared/messages";
import { normalize } from "../shared/normalize";
import type {
  ApiError,
  CachedDecision,
  Decision,
  EssayItem,
  FrameStatus,
  NeedsYouItem,
  RuntimeConfig,
  StatusCounts,
} from "../shared/types";
import { detect } from "./detect";
import { extractJobContext } from "./jobContextExtract";
import { deterministicValue, isFreeText, matchLearned } from "./match/deterministic";
import { localMatchAll } from "./match/localMatch";
import { harvestOptions } from "./fill/dropdown";
import { fill, serial, type FillOp, type FillResult } from "./fill/engine";
import { isFilling, sleep } from "./fill/events";
import { findDropzones } from "./fill/file";
import { readValue } from "./fill/verify";
import { newScanState, scan, type FieldHandle } from "./scan/fields";
import { removeBadge, setBadge, setBadgesVisible, type BadgeColor } from "./ui/badges";
import { showLearnPrompt } from "./ui/learnPrompt";
import { createOverlay, type Overlay } from "./ui/overlay";
import { hidePill, showPill } from "./ui/pill";
import { claimFrame } from "./ui/root";

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
const SESSION_MS = 30 * 60 * 1000;

let config: RuntimeConfig;
const scanState = newScanState();
const handles = new Map<string, FieldHandle>();
const states = new Map<string, FieldState>();
const knownSignatures = new Set<string>();
const checkedByUs = new Set<Element>();
const harvested = new Map<string, string[]>();
let current: { groupId: string; ctrl: AbortController } | null = null;
let running = false;
let dirty = false;
let queued: { rerun: boolean } | null = null;
let sessionUntil = 0;
let followRounds = 0;
let lastError: ApiError | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let timings: [string, number][] = [];
let usedModel: string | null = null;
let detectMs = 0;
let company = "";
let overlay: Overlay | null = null;
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
  if (!frames.length && !lastError) return;
  overlay ??= createOverlay(
    {
      onRerun: () => void send({ type: "BROADCAST_FILL", rerun: true }),
      onStop: stop,
      onPause: () => {
        stop();
        void send({ type: "SET_SITE_RULE", host: HOST, autoFill: "off" });
      },
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
  const childError = [...childFrames.values()].find((f) => f.error)?.error;
  overlay.update({
    counts: total,
    needsYou: frames.flatMap((f) => f.needsYou.map((n) => ({ ...n, frameId: f.frameId }))),
    running: frames.some((f) => f.running),
    error: lastError ?? (childError ? { kind: "other", message: childError } : null),
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

const cacheSig = (h: FieldHandle) =>
  company && normalize(h.desc.label).includes(normalize(company)) ? `${h.signature}@${HOST}` : h.signature;

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
  if (d.optionIndexes?.length && h.desc.options)
    return { type: "options", texts: d.optionIndexes.map((i) => h.desc.options![i]) };
  if (k === "dropdown" || k === "typeahead") {
    const answer = d.intendedAnswer ?? d.text;
    return answer ? { type: "intended", answer, query: d.searchQuery } : null;
  }
  if (isFreeText(k)) return d.text ? { type: "text", value: d.text } : null;
  const answer = d.intendedAnswer ?? d.text;
  return answer ? { type: "intended", answer } : null;
}

function opFromCached(h: FieldHandle, c: CachedDecision): FillOp | null {
  const k = h.desc.kind;
  if (c.documentId && k === "file") return { type: "file", documentId: c.documentId };
  if (c.checked !== undefined && k === "checkbox") return { type: "checked", value: c.checked };
  if (c.optionTexts?.length) {
    const opts = h.desc.options;
    if (opts && !c.optionTexts.every((t) => opts.some((o) => normalize(o) === normalize(t)))) return null;
    return { type: "options", texts: c.optionTexts };
  }
  if (c.text)
    return k === "typeahead" || k === "dropdown"
      ? { type: "intended", answer: c.text }
      : { type: "text", value: c.text };
  return null;
}

function cachedFrom(op: FillOp, r: FillResult, h: FieldHandle): CachedDecision | null {
  const base = { action: "fill" as const, source: "ai" as const, savedAt: Date.now() };
  if (op.type === "text") return { ...base, text: op.value };
  if (op.type === "options") return { ...base, optionTexts: op.texts };
  if (op.type === "checked") return { ...base, checked: op.value };
  if (op.type === "file") return { ...base, documentId: op.documentId };
  if (h.desc.kind === "typeahead") return r.shown ? { ...base, text: r.shown } : null;
  return r.shown ? { ...base, optionTexts: r.shown.split(" | ") } : null;
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
  for (const h of all) handles.set(h.id, h);
  return all;
}

async function doFill(
  h: FieldHandle,
  op: FillOp,
  okStatus: Status,
  tooltip: string,
  ctrl: AbortController,
  cache?: { signature: string; decision: CachedDecision }[],
) {
  if (states.get(h.id)?.userOwned) return;
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
    const c = cache && cachedFrom(op, r, h);
    if (c) cache.push({ signature: cacheSig(h), decision: c });
  } else if (r.outcome === "mismatch") setStatus(h, "check", r.note, tooltip);
  else if (r.outcome === "failed") setStatus(h, "failed", r.note);
  else setStatus(h, "needs", r.note);
}

function handleConsent(h: FieldHandle, checked: boolean | undefined, ctrl: AbortController, jobs: Promise<void>[]) {
  if (config.settings.autoAcceptAcknowledgements && checked !== false)
    jobs.push(doFill(h, { type: "checked", value: true }, "ai", "Auto-accepted", ctrl));
  else setStatus(h, "needs", "Needs your confirmation");
}

async function runPipeline(opts: { rerun?: boolean } = {}) {
  if (running) {
    queued = { rerun: !!opts.rerun || !!queued?.rerun };
    return;
  }
  running = true;
  dirty = false;
  lastError = null;
  clearTimeout(retryTimer);
  hidePill();
  const ctrl = new AbortController();
  const groupId = crypto.randomUUID();
  current = { groupId, ctrl };
  const t0 = performance.now();
  timings = detectMs ? [["detect", detectMs]] : [];
  const mark = (k: string) => timings.push([k, Math.round(performance.now() - t0)]);
  sessionUntil = Date.now() + SESSION_MS;
  const jobs: Promise<void>[] = [];
  const cacheOut: { signature: string; decision: CachedDecision }[] = [];
  try {
    config = await send({ type: "GET_RUNTIME_CONFIG" });
    setBadgesVisible(config.settings.showBadges);
    const all = rescan();
    mark("scan");
    const targets = all.filter((h) => {
      knownSignatures.add(h.signature);
      const s = states.get(h.id);
      if (s?.userOwned) return false;
      if (!s || s.status === "pending") return true;
      return !!opts.rerun && ["needs", "failed", "check"].includes(s.status);
    });
    for (const h of targets) setStatus(h, "pending");
    report();

    // Job context: top frame extracts; child frames share theirs only when they hold a description.
    const jc = extractJobContext();
    if (TOP || jc.text) await send({ type: "SET_JOB_CONTEXT", ctx: jc });
    company = (TOP ? jc.company : (await send({ type: "GET_JOB_CONTEXT" }))?.company) ?? "";

    // PHASE A: deterministic, learned answers, decision cache — no network to Gemini.
    const det = config.profileSnapshotForDeterministic;
    const hasCountryCode = all.some((h) => /country code|dialing code/i.test(h.desc.label));
    const usedLearned: string[] = [];
    let pending: FieldHandle[] = [];
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
      const d = deterministicValue(h.desc, det.personal, hasCountryCode);
      if (d) {
        jobs.push(doFill(h, { type: "text", value: d.value }, "filled", d.path, ctrl));
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
    if (pending.length) {
      const hits = await send({ type: "CACHE_LOOKUP", signatures: pending.map(cacheSig) });
      pending = pending.filter((h) => {
        const c = hits[cacheSig(h)];
        const op = c && opFromCached(h, c);
        if (op) jobs.push(doFill(h, op, "ai", "Cached AI answer", ctrl));
        return !op;
      });
    }
    mark("phaseA");

    // PHASE B: one batched mapping call (chunked in the background), pre-harvesting dropdowns meanwhile.
    if (pending.length && !ctrl.signal.aborted) {
      for (const h of pending) setStatus(h, "working");
      const mapped = send({ type: "MAP_FIELDS", fields: pending.map((h) => h.desc), host: HOST, groupId });
      const toHarvest = pending.filter((h) => h.desc.kind === "dropdown" && !h.desc.optionsKnown).slice(0, 15);
      for (const h of toHarvest)
        void serial(async () => {
          if (ctrl.signal.aborted || harvested.has(h.id)) return;
          const opts = await harvestOptions(h, 400);
          if (opts) harvested.set(h.id, opts);
        });
      const res = await mapped;
      mark("map");
      if (isErr(res)) {
        lastError = res.error;
        for (const h of pending) setStatus(h, "needs", res.error.message);
        scheduleAutoRetry(res.error);
      } else {
        usedModel = res.usedModel;
        const essays: EssayItem[] = [];
        for (const d of res.decisions) {
          const h = handles.get(d.fieldId);
          if (!h || states.get(h.id)?.userOwned) continue;
          const suggestion = d.suggestion ? `Suggested: ${d.suggestion}` : undefined;
          if (d.action === "fill") {
            const op = opFromDecision(h, d);
            if (op) jobs.push(doFill(h, op, "ai", (d.sources ?? []).join(", ") || "AI", ctrl, cacheOut));
            else setStatus(h, "needs", d.note ?? "No usable AI answer", suggestion);
          } else if (d.action === "essay") {
            if (config.settings.draftEssays) {
              const limits = parseEssayLimits(h.desc.label, h.desc.hint, h.desc.maxLength);
              const kind = RE_COVER_LETTER.test(h.desc.label) ? "cover_letter" : "essay";
              essays.push({ fieldId: h.id, question: h.desc.label, hint: h.desc.hint, ...limits, kind });
            } else setStatus(h, "needs", "Write this yourself");
          } else if (d.action === "consent") handleConsent(h, d.checked, ctrl, jobs);
          else if (d.action === "skip") setStatus(h, "skipped");
          else setStatus(h, "needs", d.note ?? "AI could not answer", suggestion);
        }
        if (essays.length) jobs.push(draftEssays(essays, groupId, ctrl, mark));
      }
    }
    await Promise.all(jobs);
    mark("done");
    if (cacheOut.length) void send({ type: "CACHE_STORE", entries: cacheOut });
  } catch (e) {
    lastError = { kind: "other", message: (e as Error)?.message ?? String(e) };
  } finally {
    running = false;
    current = null;
    report();
    if (queued) {
      const q = queued;
      queued = null;
      void runPipeline(q);
    } else if (dirty) void onMutations();
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

// ---------- SPA / multi-step (§11.8) ----------
let detected = false;

/** `t0`: when the bootstrap scan started, to log scan + detection time (§19). */
function maybeAuto(all: FieldHandle[], t0?: number) {
  const d = detect(all);
  if (t0 !== undefined) detectMs = Math.round(performance.now() - t0);
  const fillable = all.length;
  if (config.settings.debugLogging) console.log("[AutoApply] detection", d.score, d.signals);
  if (d.score >= config.settings.detectionThreshold && config.effectiveAutoFill && fillable >= 3) {
    detected = true;
    void runPipeline();
  } else if (d.score >= config.settings.maybeThreshold && (TOP || fillable >= 3) && fillable > 0) {
    showPill(() => void send({ type: "BROADCAST_FILL", rerun: false }));
  }
}

const sessionActive = () => Date.now() < sessionUntil;

async function onMutations() {
  if (running) {
    dirty = true;
    return;
  }
  // Skip the full DOM walk when its result can't be used: runPipeline re-records every signature on its next start.
  if (sessionActive() ? followRounds >= 3 : detected) return;
  const { handles: hs } = scan(scanState);
  const fresh = hs.filter((h) => !knownSignatures.has(h.signature) && !states.has(h.id));
  if (!fresh.length) return;
  if (sessionActive()) {
    followRounds++;
    void runPipeline();
  } else {
    hs.forEach((h) => knownSignatures.add(h.signature));
    maybeAuto(hs);
  }
}

function observe() {
  let t: ReturnType<typeof setTimeout> | undefined;
  const mo = new MutationObserver(() => {
    if (t) return;
    t = setTimeout(() => {
      t = undefined;
      // Orphaned by an extension reload before the new instance claimed the frame: chrome.* calls in scan() would throw.
      if (!chrome.runtime?.id) return mo.disconnect();
      void onMutations();
    }, 500);
  });
  mo.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "hidden", "style", "class"],
  });
  life.signal.addEventListener("abort", () => {
    mo.disconnect();
    clearTimeout(t);
  });
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (!config) return false;
  switch (msg.type) {
    case "TRIGGER_FILL":
      followRounds = 0;
      hidePill();
      void runPipeline({ rerun: msg.rerun ?? msg.force });
      break;
    case "URL_CHANGED":
      followRounds = 0;
      if (sessionActive()) void onMutations();
      else {
        detected = false;
        maybeAuto(scan(scanState).handles);
      }
      break;
    case "AUTOFILL_CHANGED":
      void send({ type: "GET_RUNTIME_CONFIG" }).then((c) => {
        config = c;
        if (c.effectiveAutoFill) return;
        // Turned off: halt the current run and anything that would start another on its own.
        sessionUntil = 0;
        queued = null;
        clearTimeout(retryTimer);
        stop();
      });
      break;
    case "FOCUS_FIELD":
      focusField(msg.fieldId);
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
const settle = () =>
  new Promise<void>((resolve) => {
    const start = Date.now();
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      mo.disconnect();
      resolve();
    };
    const mo = new MutationObserver(() => {
      clearTimeout(quiet);
      if (Date.now() - start > 2500) done();
      else quiet = setTimeout(done, 300);
    });
    mo.observe(document.documentElement, { subtree: true, childList: true });
    quiet = setTimeout(done, 300);
  });

const CONTROLS = "input,select,textarea,[contenteditable],[role=combobox]";
const hasControls = () => !!document.querySelector(CONTROLS) || scan(scanState).handles.length > 0;

async function main() {
  if (!/^https?:$/.test(location.protocol) || !document.body) return;
  const g = globalThis as { __autoapply?: boolean };
  if (g.__autoapply) return;
  g.__autoapply = true;
  claimFrame(() => {
    life.abort();
    current?.ctrl.abort(); // no ABORT message: this context's runtime is gone
    sessionUntil = 0;
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
  for (const ev of ["click", "keydown"])
    document.addEventListener(ev, (e) => e.isTrusted && !isFilling() && (followRounds = 0), opts);

  if (!hasControls()) {
    const appeared = await new Promise<boolean>((resolve) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const done = (ok: boolean) => {
        mo.disconnect();
        clearTimeout(t);
        resolve(ok);
      };
      // Cheap selector check per batch; the full-scan fallback (custom widgets) is throttled like observe().
      const mo = new MutationObserver(() => {
        if (document.querySelector(CONTROLS)) done(true);
        else
          t ??= setTimeout(() => {
            t = undefined;
            if (hasControls()) done(true);
          }, 500);
      });
      mo.observe(document.documentElement, { subtree: true, childList: true });
      setTimeout(() => done(hasControls()), 3000);
    });
    if (!appeared) return;
  }
  await settle();
  const t0 = performance.now();
  const all = scan(scanState).handles;
  all.forEach((h) => knownSignatures.add(h.signature));
  maybeAuto(all, t0);
  observe();
}

void main();
