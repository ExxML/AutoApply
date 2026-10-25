// Service worker: message router, commands, onInstalled.
import type { Message, Responses } from "../shared/messages";
import { createStorage, migrate, session } from "../shared/storage";
import { normalize } from "../shared/normalize";
import { formatTime } from "../shared/time";
import type { ApiError, EntryCounts, ModelCaps, Profile, Settings, TabStatus } from "../shared/types";
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
import { getJobContext, getJobPay, setJobContext, setJobPay } from "./jobContext";
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
  store.onChange(["settings", "apiKeys", "modelCapabilities"], (c) => {
    Object.keys(c).forEach((k) => changed.add(k));
    if (c.settings) settings = c.settings;
    if (c.apiKeys) pool.setKeys(c.apiKeys);
    if (c.modelCapabilities) caps = Object.keys(c.modelCapabilities).length ? { ...caps, ...c.modelCapabilities } : {};
  });
  await migrate();
  const s = await store.getMany(["settings", "apiKeys", "keyState", "modelCapabilities"]);
  if (!changed.has("settings")) settings = s.settings;
  pool.setKeys(changed.has("apiKeys") ? pool.keys : s.apiKeys, s.keyState);
  caps = { ...s.modelCapabilities, ...caps };
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

const isExcluded = (host: string) => settings.excludedHosts.some((h) => h && (host === h || host.endsWith("." + h)));

/**
 * The tab's status from the page it now shows: frames that reported before that page's navigation began are an
 * earlier page's. Checked when the popup asks, instead of a tabs.onUpdated listener waking the service worker on
 * every tab change.
 */
async function currentTabStatus(tabId: number): Promise<TabStatus | null> {
  const s = await session.getTabStatus(tabId);
  if (!s) return null;
  const since = await chrome.scripting
    // Immediately: by default it waits for a loading page to go idle, delaying the popup.
    .executeScript({ target: { tabId, frameIds: [0] }, injectImmediately: true, func: () => performance.timeOrigin })
    .then(([r]) => Number(r?.result ?? Infinity))
    .catch(() => Infinity); // a browser page: nothing of ours runs there
  const frames = Object.fromEntries(Object.entries(s.frames).filter(([, f]) => (f.at ?? 0) >= since));
  if (Object.keys(frames).length === Object.keys(s.frames).length) return s;
  const fresh = { ...s, frames };
  await session.setTabStatus(tabId, fresh);
  return fresh;
}

/** Drops closed tabs' session data on a fill, instead of a tabs.onRemoved listener waking the worker on every close. */
const pruneClosedTabs = () => chrome.tabs.query({}).then((tabs) => session.pruneTabs(new Set(tabs.map((t) => t.id))));

const sendToTab = (tabId: number, msg: Message, frameId?: number) =>
  chrome.tabs.sendMessage(tabId, msg, frameId === undefined ? {} : { frameId }).catch(() => undefined);

function entryCounts(p: Profile): EntryCounts {
  const { links } = p.personal;
  return {
    experience: p.experience.filter((e) => e.title || e.company).length,
    education: p.education.filter((e) => e.school).length,
    certifications: p.skills.certifications.filter((c) => c.name).length,
    languages: p.skills.languages.filter((l) => l.language).length,
    projects: p.projects.filter((x) => x.name).length,
    // LinkedIn has its own field on the forms that have a Websites section
    websites: [links.github, links.portfolio, links.website, ...links.other.map((o) => o.url)].filter(Boolean).length,
  };
}

// ---------- router ----------
type Handler<T extends Message["type"]> = (
  msg: Extract<Message, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<Responses[T]>;
type Handlers = { [T in Message["type"]]?: Handler<T> };

const handlers: Handlers = {
  async GET_RUNTIME_CONFIG(_m, sender) {
    const s = await store.getMany(["profile", "documentsIndex", "selectedModel", "overlayPos"]);
    const host = hostOf(sender.tab?.url ?? sender.url);
    const excluded = isExcluded(host);
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
      entryCounts: entryCounts(s.profile),
      documentsIndex: s.documentsIndex,
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
    if (sender.tab?.id !== undefined)
      await setJobContext(sender.tab.id, ctx, sender.frameId ? (sender.tab.url ?? "") : undefined);
    void pruneClosedTabs().catch(() => undefined);
    return { ok: true };
  },

  async SET_JOB_PAY({ pays, passive }, sender) {
    // Content scripts no longer ask on load whether a site is excluded; a read there on its own is dropped here.
    const excluded =
      isExcluded(hostOf(sender.tab?.url ?? sender.url)) || settings.excludedHosts.includes(hostOf(sender.url));
    if (sender.tab && !(passive && excluded)) await setJobPay(sender.tab, pays);
    return { ok: true };
  },

  async MAP_FIELDS({ fields, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    const s = await store.getMany(["profile", "documentsIndex"]);
    const job = sender.tab?.id !== undefined ? await getJobContext(sender.tab.id) : null;
    const pays = sender.tab ? await getJobPay(sender.tab) : [];
    return mapFields(ctx, { fields, profile: s.profile, documents: s.documentsIndex, job, pays });
  },

  async CHOOSE_OPTIONS({ items, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    return { choices: await chooseOptions(ctx, items, await store.get("profile")) };
  },

  async DRAFT_ESSAYS({ items, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    const profile = await store.get("profile");
    const job = sender.tab?.id !== undefined ? await getJobContext(sender.tab.id) : null;
    return { essays: await draftEssays(ctx, items, profile, job) };
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
    await store.set({ profile });
    return { ok: true };
  },

  async LEARNED_USED({ ids }) {
    const profile = await store.get("profile");
    const now = Date.now();
    for (const l of profile.learnedAnswers) if (ids.includes(l.id)) l.lastUsedAt = now;
    await store.set({ profile });
    return { ok: true };
  },

  async FRAME_STATUS({ status }, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: true };
    const frameId = sender.frameId ?? 0;
    const st = { ...status, frameId, at: Date.now() };
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

  // The content script's timer while its tab is hidden (see sleep in fill/events.ts).
  SLEEP: ({ ms }) => new Promise((r) => setTimeout(() => r({ ok: true }), ms)),

  async BROADCAST_FILL({ rerun }, sender) {
    if (sender.tab?.id !== undefined) await sendToTab(sender.tab.id, { type: "TRIGGER_FILL", force: true, rerun });
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
      status: await currentTabStatus(tabId),
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  if (command === "fill-page") await sendToTab(tab.id, { type: "TRIGGER_FILL", force: true });
  else if (command === "toggle-overlay") await sendToTab(tab.id, { type: "TOGGLE_OVERLAY" }, 0); // overlay lives in the top frame
});
