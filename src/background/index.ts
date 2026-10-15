// Service worker: message router, commands, webNavigation SPA hooks, onInstalled.
import type { Message, Responses } from "../shared/messages";
import { createStorage, migrate, session } from "../shared/storage";
import { normalize } from "../shared/normalize";
import { formatTime } from "../shared/time";
import type { ApiError, ModelCaps, Settings, TabStatus } from "../shared/types";
import { defaultSettings } from "../shared/settings";
import { createGemini, listModels } from "./gemini/client";
import {
  AllKeysExhaustedError,
  BadRequestError,
  BlockedError,
  classify,
  ModelGoneError,
  NoKeysError,
} from "./gemini/errors";
import { KeyPool } from "./gemini/keyPool";
import { defaultModel, updateCatalog, visibleModels } from "./gemini/models";
import { DecisionCache } from "./decisionCache";
import { getJobContext, setJobContext } from "./jobContext";
import { mapFields, type ServiceCtx } from "./services/mapFields";
import { chooseOptions } from "./services/chooseOptions";
import { draftEssays } from "./services/draftEssays";
import { parseResume } from "./services/parseResume";

const store = createStorage("background");

function throttle(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (!t)
      t = setTimeout(() => {
        t = null;
        fn();
      }, ms);
  };
}

// ---------- state (rebuilt whenever the service worker starts) ----------
let settings: Settings = defaultSettings();
let caps: Record<string, ModelCaps> = {};
const pool = new KeyPool([], {}, () => persistKeys());
const persistKeys = throttle(() => void store.set({ keyState: pool.state }), 500);
const cache = new DecisionCache({}, () => persistCache());
const persistCache = throttle(() => void store.set({ decisionCache: cache.entries }), 500);
const persistCaps = throttle(() => void store.set({ modelCapabilities: caps }), 200);

const gemini = createGemini({
  pool,
  getCaps: (m) => caps[m],
  setCaps: (m, c) => {
    caps[m] = c;
    persistCaps();
  },
  concurrency: () => settings.maxConcurrentRequests,
  debug: () => settings.debugLogging,
});

const ready = (async () => {
  // Listen before reading, and let anything that changes meanwhile win over the initial read.
  const changed = new Set<string>();
  store.onChange(["settings", "apiKeys", "modelCapabilities", "decisionCache"], (c) => {
    Object.keys(c).forEach((k) => changed.add(k));
    if (c.settings) settings = c.settings;
    if (c.apiKeys) pool.setKeys(c.apiKeys);
    if (c.modelCapabilities) caps = Object.keys(c.modelCapabilities).length ? { ...caps, ...c.modelCapabilities } : {};
    // Only an external clear (Data → Clear decision cache / Reset) empties the cache; our own writes are no-ops.
    if (c.decisionCache && !Object.keys(c.decisionCache).length) cache.clear();
  });
  await migrate();
  const s = await store.getMany(["settings", "apiKeys", "keyState", "modelCapabilities", "decisionCache"]);
  if (!changed.has("settings")) settings = s.settings;
  pool.setKeys(changed.has("apiKeys") ? pool.keys : s.apiKeys, s.keyState);
  caps = { ...s.modelCapabilities, ...caps };
  if (!changed.has("decisionCache")) cache.entries = s.decisionCache;
})();

// ---------- helpers ----------
const groups = new Map<string, AbortController>();
function groupSignal(sender: chrome.runtime.MessageSender, groupId: string): AbortSignal {
  const k = `${sender.tab?.id}:${sender.frameId}:${groupId}`;
  let c = groups.get(k);
  if (!c) groups.set(k, (c = new AbortController()));
  return c.signal;
}

function toApiError(e: unknown): ApiError {
  if (e instanceof AllKeysExhaustedError)
    return {
      kind: "allKeysExhausted",
      message: `All API keys are rate-limited for ${e.model}.${e.earliestRetryAt ? ` Next retry possible at ${formatTime(e.earliestRetryAt)}.` : ""}`,
      earliestRetryAt: e.earliestRetryAt,
    };
  if (e instanceof NoKeysError) return { kind: "noKey", message: "No API key" };
  if (e instanceof ModelGoneError) return { kind: "modelGone", message: e.message };
  if (e instanceof BlockedError) return { kind: "blocked", message: "AI declined this request" };
  if (e instanceof DOMException && e.name === "AbortError") return { kind: "other", message: "Stopped" };
  return { kind: "other", message: (e as Error)?.message ?? String(e) };
}

const hostOf = (url?: string) => {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
};

async function serviceCtx(signal?: AbortSignal): Promise<ServiceCtx | { error: ApiError }> {
  const { selectedModel, fallbackModel } = await store.getMany(["selectedModel", "fallbackModel"]);
  if (!pool.keys.length) return { error: { kind: "noKey", message: "No API key" } };
  if (!selectedModel) return { error: { kind: "noModel", message: "No model selected" } };
  return { gemini, settings, model: selectedModel, fallback: fallbackModel, signal };
}

async function refreshModels(force: boolean, onlyKey?: string): Promise<Responses["REFRESH_MODELS"]> {
  const { modelListFetchedAt, modelCatalog, selectedModel } = await store.getMany([
    "modelListFetchedAt",
    "modelCatalog",
    "selectedModel",
  ]);
  if (!force && !onlyKey && Date.now() - modelListFetchedAt < 24 * 3600 * 1000) return { ok: true };
  const keys = onlyKey
    ? [{ id: "", label: "new", key: onlyKey, addedAt: 0 }]
    : [...pool.keys].sort((a, b) => Number(!!pool.state[a.id]?.invalid) - Number(!!pool.state[b.id]?.invalid));
  let lastMsg = "No API key";
  for (const k of keys) {
    const r = await listModels(k.key);
    if ("models" in r) {
      const now = Date.now();
      const catalog = updateCatalog(modelCatalog, r.models, now);
      const sorted = visibleModels(catalog, now, now).map(([id]) => id);
      await store.set({
        modelCatalog: catalog,
        modelListFetchedAt: now,
        ...(selectedModel ? {} : { selectedModel: defaultModel(sorted) }),
      });
      if (k.id) pool.record(k.id, "", { kind: "success" }, 200);
      return { ok: true };
    }
    const c = classify(r.status, r.body);
    lastMsg = "message" in c ? c.message : `HTTP ${r.status}`;
    if (k.id) pool.record(k.id, "", c, r.status);
  }
  return { error: { kind: "other", message: lastMsg } };
}

async function updateTabStatus(tabId: number, fn: (s: TabStatus) => void) {
  const s = (await session.getTabStatus(tabId)) ?? { frames: {}, updatedAt: 0 };
  fn(s);
  s.updatedAt = Date.now();
  await session.setTabStatus(tabId, s);
}

const sendToTab = (tabId: number, msg: Message, frameId?: number) =>
  chrome.tabs.sendMessage(tabId, msg, frameId === undefined ? {} : { frameId }).catch(() => undefined);

// ---------- router ----------
type Handler<T extends Message["type"]> = (
  msg: Extract<Message, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<Responses[T]>;
type Handlers = { [T in Message["type"]]?: Handler<T> };

const handlers: Handlers = {
  async GET_RUNTIME_CONFIG(_m, sender) {
    const s = await store.getMany(["profile", "documentsIndex", "siteRules", "selectedModel", "overlayPos"]);
    const host = hostOf(sender.tab?.url ?? sender.url);
    const rule = s.siteRules[host];
    const excluded = settings.excludedHosts.some((h) => h && (host === h || host.endsWith("." + h)));
    return {
      settings,
      profileSnapshotForDeterministic: {
        personal: s.profile.personal,
        learnedAnswers: s.profile.learnedAnswers.map(({ id, question, normalizedQuestion, kind, options, answer }) => ({
          id,
          question,
          normalizedQuestion,
          kind,
          options,
          answer,
        })),
      },
      documentsIndex: s.documentsIndex,
      effectiveAutoFill: !excluded && (rule ? rule.autoFill === "on" : settings.autoFillOnDetect),
      excluded,
      selectedModel: s.selectedModel,
      hasKeys: pool.keys.length > 0,
      overlayBottom: s.overlayPos[host] ?? null,
    };
  },

  async GET_DOCUMENT({ id }) {
    const meta = (await store.get("documentsIndex")).find((d) => d.id === id);
    const base64 = meta ? await store.getDoc(id) : null;
    return meta && base64 ? { meta, base64 } : null;
  },

  async SET_JOB_CONTEXT({ ctx }, sender) {
    if (sender.tab?.id !== undefined) await setJobContext(sender.tab.id, ctx);
    return { ok: true };
  },

  async GET_JOB_CONTEXT(_m, sender) {
    return sender.tab?.id !== undefined ? getJobContext(sender.tab.id) : null;
  },

  async MAP_FIELDS({ fields, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    const s = await store.getMany(["profile", "documentsIndex"]);
    const job = sender.tab?.id !== undefined ? await getJobContext(sender.tab.id) : null;
    return mapFields(ctx, { fields, profile: s.profile, documents: s.documentsIndex, job });
  },

  async CHOOSE_OPTIONS({ items, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    return { choices: await chooseOptions(ctx, items) };
  },

  async DRAFT_ESSAYS({ items, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    const profile = await store.get("profile");
    const job = sender.tab?.id !== undefined ? await getJobContext(sender.tab.id) : null;
    return { essays: await draftEssays(ctx, items, profile, job) };
  },

  async CACHE_LOOKUP({ signatures }) {
    return cache.lookup(signatures, await store.get("profileVersion"));
  },

  async CACHE_STORE({ entries }) {
    cache.store(entries, await store.get("profileVersion"));
    return { ok: true };
  },

  async SAVE_LEARNED_ANSWER({ answer }) {
    const profile = await store.get("profile");
    const nq = normalize(answer.question);
    const now = Date.now();
    const existing = profile.learnedAnswers.find((l) => l.normalizedQuestion === nq && l.kind === answer.kind);
    if (existing)
      Object.assign(existing, { answer: answer.answer, options: answer.options, host: answer.host, lastUsedAt: now });
    else
      profile.learnedAnswers.push({
        id: crypto.randomUUID(),
        question: answer.question,
        normalizedQuestion: nq,
        kind: answer.kind,
        options: answer.options,
        answer: answer.answer,
        host: answer.host,
        createdAt: now,
        lastUsedAt: now,
      });
    await store.setProfile(profile);
    return { ok: true };
  },

  async LEARNED_USED({ ids }) {
    const profile = await store.get("profile");
    const now = Date.now();
    for (const l of profile.learnedAnswers) if (ids.includes(l.id)) l.lastUsedAt = now;
    await store.setProfile(profile);
    return { ok: true };
  },

  async FRAME_STATUS({ status }, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: true };
    const frameId = sender.frameId ?? 0;
    const st = { ...status, frameId };
    await updateTabStatus(tabId, (s) => void (s.frames[String(frameId)] = st));
    if (frameId !== 0) await sendToTab(tabId, { type: "FRAME_STATUS", status: st }, 0);
    return { ok: true };
  },

  async ABORT({ groupId }, sender) {
    const k = `${sender.tab?.id}:${sender.frameId}:${groupId}`;
    groups.get(k)?.abort();
    groups.delete(k);
    return { ok: true };
  },

  async BROADCAST_FILL({ rerun }, sender) {
    if (sender.tab?.id !== undefined) await sendToTab(sender.tab.id, { type: "TRIGGER_FILL", force: true, rerun });
    return { ok: true };
  },

  async SET_SITE_RULE({ host, autoFill }) {
    const siteRules = await store.get("siteRules");
    siteRules[host] = { autoFill };
    await store.set({ siteRules });
    return { ok: true };
  },

  async SET_OVERLAY_POS({ host, bottom }) {
    const overlayPos = await store.get("overlayPos");
    overlayPos[host] = bottom;
    await store.set({ overlayPos });
    return { ok: true };
  },

  async OPEN_OPTIONS({ hash }) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html#${hash}`) });
    return { ok: true };
  },

  async FOCUS_FIELD(msg, sender) {
    if (sender.tab?.id !== undefined) await sendToTab(sender.tab.id, msg, msg.frameId);
    return { ok: true };
  },

  async TAB_STATUS({ tabId }) {
    const selectedModel = await store.get("selectedModel");
    return {
      status: await session.getTabStatus(tabId),
      model: selectedModel,
      keysTotal: pool.keys.length,
      keysHealthy: pool.healthyCount(selectedModel),
    };
  },

  async ADD_KEY({ label, key }) {
    const k = key.trim();
    if (!k) return { error: { kind: "other", message: "Enter a key" } };
    const keys = await store.get("apiKeys");
    if (keys.some((e) => e.key === k)) return { error: { kind: "other", message: "This key is already added" } };
    const r = await refreshModels(true, k);
    if ("error" in r) return r;
    const entry = {
      id: crypto.randomUUID(),
      label: label.trim() || `Key ${keys.length + 1}`,
      key: k,
      addedAt: Date.now(),
    };
    await store.set({ apiKeys: [...keys, entry] });
    pool.setKeys([...keys, entry]);
    return { ok: true };
  },

  async TEST_KEY({ id }) {
    const entry = pool.keys.find((k) => k.id === id);
    if (!entry) return { error: { kind: "other", message: "Unknown key" } };
    const r = await listModels(entry.key);
    if ("models" in r) {
      pool.record(id, "", { kind: "success" }, 200);
      return { ok: true };
    }
    const c = classify(r.status, r.body);
    pool.record(id, "", c, r.status);
    return { error: { kind: "other", message: "message" in c ? c.message : `HTTP ${r.status}` } };
  },

  async REFRESH_MODELS({ force }) {
    return refreshModels(force);
  },

  async VALIDATE_MODEL({ model }) {
    try {
      await gemini.validateModel(model);
      return { ok: true };
    } catch (e) {
      return { error: toApiError(e) };
    }
  },

  async PARSE_RESUME({ text }) {
    const ctx = await serviceCtx();
    if ("error" in ctx) return ctx;
    return { proposed: await parseResume(ctx, text) };
  },
};

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  const h = handlers[msg?.type] as Handler<Message["type"]> | undefined;
  if (!h) return false;
  ready
    .then(() => h(msg as never, sender))
    .then(sendResponse, (e) => {
      if (!(e instanceof BadRequestError)) console.warn("[AutoApply]", msg.type, (e as Error)?.message);
      sendResponse({ error: toApiError(e) });
    });
  return true;
});

// ---------- browser events ----------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ready;
  if (reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("src/options/index.html#/setup") });
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined || !/^https?:/.test(tab.url ?? "")) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files }).catch(() => undefined);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "fill-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await sendToTab(tab.id, { type: "TRIGGER_FILL", force: true });
});

const onSpaNav = (d: { tabId: number; frameId: number; url: string }) =>
  void sendToTab(d.tabId, { type: "URL_CHANGED", url: d.url }, d.frameId);
chrome.webNavigation.onHistoryStateUpdated.addListener(onSpaNav);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSpaNav);
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) void session.setTabStatus(d.tabId, { frames: {}, updatedAt: Date.now() });
});
chrome.tabs.onRemoved.addListener((tabId) => void session.clearTab(tabId));

// Open pages cache effectiveAutoFill from load; tell them to refresh when a toggle changes.
store.onChange(["settings", "siteRules"], async () => {
  for (const tab of await chrome.tabs.query({}))
    if (tab.id !== undefined) void sendToTab(tab.id, { type: "AUTOFILL_CHANGED" });
});
