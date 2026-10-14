import { describe, expect, it } from "vitest";
import { classify } from "../../src/background/gemini/errors";
import { KeyPool } from "../../src/background/gemini/keyPool";
import { createGemini, type GeminiDeps } from "../../src/background/gemini/client";
import {
  defaultModel,
  isTextModel,
  modelBadges,
  updateCatalog,
  visibleModels,
  type ApiModel,
} from "../../src/background/gemini/models";
import { AllKeysExhaustedError } from "../../src/background/gemini/errors";
import { ValidationZ } from "../../src/background/gemini/schemas";
import type { ApiKeyEntry, ModelCaps } from "../../src/shared/types";

// ---------- real-shaped error bodies ----------
const err = (code: number, status: string, message: string, details: unknown[] = []) => ({
  error: { code, status, message, details },
});
const QUOTA_FAILURE = "type.googleapis.com/google.rpc.QuotaFailure";
const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";

describe("error classification (§10.6)", () => {
  it("200 + candidates → success", () => {
    expect(classify(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }] })).toEqual({
      kind: "success",
    });
  });
  it("400 API key invalid → rotateKey/invalid (message and details reason)", () => {
    const body = err(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" },
    ]);
    expect(classify(400, body)).toMatchObject({ kind: "rotateKey", effect: "invalid" });
    expect(classify(400, err(400, "INVALID_ARGUMENT", "Bad.", [{ reason: "API_KEY_INVALID" }]))).toMatchObject({
      kind: "rotateKey",
      effect: "invalid",
    });
  });
  it.each([401, 402, 403])("%i → rotateKey/invalid", (s) => {
    expect(classify(s, err(s, "PERMISSION_DENIED", "Permission denied"))).toMatchObject({
      kind: "rotateKey",
      effect: "invalid",
    });
  });
  it("400 FAILED_PRECONDITION → rotateKey/unavailable", () => {
    const body = err(
      400,
      "FAILED_PRECONDITION",
      "User location is not supported for the API use without a billing account linked.",
    );
    expect(classify(400, body)).toMatchObject({ kind: "rotateKey", effect: "unavailable" });
  });
  it("429 limit: 0 → rotateKey/unavailable", () => {
    const body = err(
      429,
      "RESOURCE_EXHAUSTED",
      "You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-x-pro",
      [
        {
          "@type": QUOTA_FAILURE,
          violations: [
            { quotaMetric: "m", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "0" },
          ],
        },
      ],
    );
    expect(classify(429, body)).toMatchObject({ kind: "rotateKey", effect: "unavailable" });
  });
  it("429 per-day quota → rotateKey/exhausted", () => {
    const body = err(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", [
      {
        "@type": QUOTA_FAILURE,
        violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "1000" }],
      },
      { "@type": RETRY_INFO, retryDelay: "40s" },
    ]);
    expect(classify(429, body)).toMatchObject({ kind: "rotateKey", effect: "exhausted" });
  });
  it("other 429 → rotateKey/cooldown with RetryInfo delay", () => {
    const body = err(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", [
      {
        "@type": QUOTA_FAILURE,
        violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "15" }],
      },
      { "@type": RETRY_INFO, retryDelay: "12s" },
    ]);
    expect(classify(429, body)).toMatchObject({ kind: "rotateKey", effect: "cooldown", retryDelayMs: 12000 });
    expect(classify(429, err(429, "RESOURCE_EXHAUSTED", "Too many requests"))).toMatchObject({
      effect: "cooldown",
      retryDelayMs: undefined,
    });
  });
  it.each([500, 502, 503, 504, 408, 0])("%i → serverTransient", (s) => {
    expect(classify(s, err(s, "UNAVAILABLE", "The model is overloaded. Please try again later.")).kind).toBe(
      "serverTransient",
    );
  });
  it("400 mentioning thinking / schema → capability", () => {
    expect(
      classify(400, err(400, "INVALID_ARGUMENT", "Thinking level is not supported for this model.")),
    ).toMatchObject({ kind: "capability", what: "thinking" });
    expect(
      classify(400, err(400, "INVALID_ARGUMENT", 'Invalid JSON payload received. Unknown name "response_schema"')),
    ).toMatchObject({ kind: "capability", what: "schema" });
  });
  it("404 → modelGone", () => {
    expect(classify(404, err(404, "NOT_FOUND", "models/gemini-old is not found for API version v1beta")).kind).toBe(
      "modelGone",
    );
  });
  it("blockReason / blocked finishReason → blocked", () => {
    expect(classify(200, { promptFeedback: { blockReason: "SAFETY" } }).kind).toBe("blocked");
    for (const f of ["SAFETY", "PROHIBITED_CONTENT", "SPII", "BLOCKLIST", "RECITATION", "OTHER"])
      expect(classify(200, { candidates: [{ finishReason: f }] }).kind).toBe("blocked");
  });
  it("other 4xx → badRequest; tolerates missing/garbage bodies", () => {
    expect(classify(400, err(400, "INVALID_ARGUMENT", "Request contains an invalid argument.")).kind).toBe(
      "badRequest",
    );
    expect(classify(409, "conflict").kind).toBe("badRequest");
    expect(classify(400, null).kind).toBe("badRequest");
    expect(classify(429, undefined)).toMatchObject({ kind: "rotateKey", effect: "cooldown" });
  });
});

// ---------- model list ----------
const M = (name: string, methods = ["generateContent", "countTokens"]): ApiModel => ({
  name: `models/${name}`,
  displayName: name,
  supportedGenerationMethods: methods,
});
const FIXTURE: ApiModel[] = [
  M("embedding-001", ["embedContent"]),
  M("gemini-embedding-001", ["embedContent"]),
  M("gemini-2.5-flash"),
  M("gemini-2.5-flash-lite"),
  M("gemini-2.5-pro"),
  M("gemini-2.5-flash-preview-tts"),
  M("gemini-2.5-flash-image"),
  M("gemma-3-27b-it"),
  M("gemini-2.5-flash-live-preview", ["bidiGenerateContent"]),
  M("gemini-live-2.5-flash"),
  M("gemini-flash-latest"),
  M("gemini-flash-lite-latest"),
  M("gemini-2.5-flash-preview-09-2025"),
  M("gemini-2.0-flash"),
  M("gemini-3-pro-preview"),
  M("imagen-4.0-generate-001", ["predict"]),
  M("aqa", ["generateAnswer"]),
  M("veo-3.0-generate-preview", ["predictLongRunning"]),
  M("gemini-2.5-computer-use-preview-10-2025"),
  M("learnlm-2.0-flash-experimental"),
];

describe("model list filter and sort (§10.3)", () => {
  it("keeps only text generateContent models", () => {
    const kept = FIXTURE.filter(isTextModel).map((m) => m.name.slice(7));
    expect(kept.sort()).toEqual(
      [
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-pro",
        "gemini-flash-latest",
        "gemini-flash-lite-latest",
        "gemini-2.5-flash-preview-09-2025",
        "gemini-2.0-flash",
        "gemini-3-pro-preview",
      ].sort(),
    );
  });

  it("sorts by version, then date code, then apiIndex on first fetch", () => {
    const t1 = Date.UTC(2026, 0, 1);
    const cat = updateCatalog({}, FIXTURE, t1);
    const order = visibleModels(cat, t1, t1).map(([id]) => id);
    expect(order).toEqual([
      "gemini-3-pro-preview",
      "gemini-2.5-flash-preview-09-2025",
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-flash-lite-latest",
      "gemini-flash-latest",
    ]);
    expect(defaultModel(order)).toBe("gemini-2.5-flash-lite");
  });

  it("models first seen in a later fetch sort first and get the New badge", () => {
    const t1 = Date.UTC(2026, 0, 1);
    const t2 = t1 + 24 * 3600 * 1000;
    let cat = updateCatalog({}, FIXTURE, t1);
    cat = updateCatalog(cat, [...FIXTURE, M("gemini-1.5-flash-8b")], t2);
    const order = visibleModels(cat, t2, t2).map(([id]) => id);
    expect(order[0]).toBe("gemini-1.5-flash-8b");
    expect(cat["gemini-2.5-flash"].firstSeenAt).toBe(t1);
    expect(cat["gemini-2.5-flash"].lastSeenAt).toBe(t2);
    expect(modelBadges("gemini-1.5-flash-8b", cat["gemini-1.5-flash-8b"], cat, t2)).toContain("New");
    expect(modelBadges("gemini-2.5-flash", cat["gemini-2.5-flash"], cat, t2)).not.toContain("New");
    expect(modelBadges("gemini-flash-latest", cat["gemini-flash-latest"], cat, t2)).toContain("Alias");
    expect(modelBadges("gemini-3-pro-preview", cat["gemini-3-pro-preview"], cat, t2)).toContain("Preview");
  });

  it("hides models absent from the latest fetch and drops them after 30 days", () => {
    const t1 = Date.UTC(2026, 0, 1);
    let cat = updateCatalog({}, FIXTURE, t1);
    const t2 = t1 + 1000;
    cat = updateCatalog(
      cat,
      FIXTURE.filter((m) => !m.name.includes("2.0")),
      t2,
    );
    expect(visibleModels(cat, t2, t2).map(([id]) => id)).not.toContain("gemini-2.0-flash");
    expect(cat["gemini-2.0-flash"]).toBeTruthy();
    cat = updateCatalog(cat, [], t1 + 31 * 24 * 3600 * 1000);
    expect(cat["gemini-2.0-flash"]).toBeUndefined();
  });
});

// ---------- key pool ----------
const keys = (n: number): ApiKeyEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `k${i + 1}`, label: `Key ${i + 1}`, key: `key-${i + 1}`, addedAt: i }));

describe("key pool (§10.5)", () => {
  it("selects least-recently-used healthy keys", () => {
    let now = 1000;
    const pool = new KeyPool(keys(3), {}, undefined, () => now);
    const picks = [
      pool.select("m")!.id,
      (now++, pool.select("m")!.id),
      (now++, pool.select("m")!.id),
      (now++, pool.select("m")!.id),
    ];
    expect(picks).toEqual(["k1", "k2", "k3", "k1"]);
  });

  it("skips cooling-down keys until the cooldown passes", () => {
    let now = 1000;
    const pool = new KeyPool(keys(2), {}, undefined, () => now);
    pool.record("k1", "m", { kind: "rotateKey", effect: "cooldown", message: "x", retryDelayMs: 10_000 }, 429);
    expect(pool.select("m")!.id).toBe("k2");
    now += 1;
    expect(pool.select("m")!.id).toBe("k2");
    now += 13_000;
    expect(pool.select("m")!.id).toBe("k1");
  });

  it("daily exhaustion lasts until next Pacific midnight, per model, across DST", () => {
    for (const start of [Date.UTC(2026, 2, 8, 9), Date.UTC(2026, 10, 1, 12), Date.UTC(2026, 6, 1, 20)]) {
      let now = start;
      const pool = new KeyPool(keys(1), {}, undefined, () => now);
      pool.record("k1", "m", { kind: "rotateKey", effect: "exhausted", message: "per day" }, 429);
      expect(pool.select("m")).toBeNull();
      expect(pool.select("other")!.id).toBe("k1");
      const reset = pool.state.k1.perModel!.m.exhaustedUntil!;
      const la = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
      expect(la.format(reset)).toBe("00:00");
      expect(reset - start).toBeLessThanOrEqual(25 * 3600 * 1000);
      now = reset - 1;
      expect(pool.select("m")).toBeNull();
      now = reset;
      expect(pool.select("m")!.id).toBe("k1");
    }
  });

  it("never selects invalid keys", () => {
    const pool = new KeyPool(keys(2), {});
    pool.record("k1", "m", { kind: "rotateKey", effect: "invalid", message: "API key not valid" }, 400);
    for (let i = 0; i < 3; i++) expect(pool.select("m")!.id).toBe("k2");
    expect(pool.healthyCount("m")).toBe(1);
  });
});

// ---------- client: rotation, fallback, probing ----------
type Reply =
  | { status: number; body: unknown }
  | ((key: string, model: string, body: Record<string, unknown>) => { status: number; body: unknown });
const ok = (obj: unknown) => ({
  status: 200,
  body: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }] },
});

function harness(n: number, reply: Reply, capsInit: Record<string, ModelCaps> = {}) {
  const calls: { key: string; model: string; body: Record<string, unknown> }[] = [];
  const caps = { ...capsInit };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)["x-goog-api-key"];
    const model = /models\/([^:]+):/.exec(url)![1];
    const body = JSON.parse(init.body as string);
    calls.push({ key, model, body });
    const r = typeof reply === "function" ? reply(key, model, body) : reply;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const pool = new KeyPool(keys(n), {});
  const deps: GeminiDeps = {
    pool,
    getCaps: (m) => caps[m],
    setCaps: (m, c) => (caps[m] = c),
    concurrency: () => 4,
    fetchImpl,
    sleep: async () => {},
  };
  return { gemini: createGemini(deps), calls, caps, pool };
}
const fresh: ModelCaps = {
  thinking: { kind: "level", value: "minimal" },
  schema: "responseSchema",
  verifiedAt: Date.now(),
};
const spec = {
  system: "s",
  payload: { a: 1 },
  schema: {},
  validate: (d: unknown) => ValidationZ.parse(d),
  timeoutMs: 5000,
};

describe("callGemini rotation", () => {
  it("rotates to the next key after a 429 without user action", async () => {
    const h = harness(
      3,
      (key) =>
        key === "key-1" ? { status: 429, body: err(429, "RESOURCE_EXHAUSTED", "Too many requests") } : ok({ ok: true }),
      { m: fresh },
    );
    const r = await h.gemini.call(spec, { model: "m" });
    expect(r.data).toEqual({ ok: true });
    expect(h.calls.map((c) => c.key)).toEqual(["key-1", "key-2"]);
    expect(h.pool.state.k1.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("uses the fallback model when every key is exhausted for the primary", async () => {
    const h = harness(
      2,
      (_k, model) =>
        model === "primary"
          ? {
              status: 429,
              body: err(429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric 'GenerateRequestsPerDay'"),
            }
          : ok({ ok: true }),
      { primary: fresh, fb: fresh },
    );
    const r = await h.gemini.call(spec, { model: "primary", fallback: "fb" });
    expect(r.usedModel).toBe("fb");
    expect(h.calls.filter((c) => c.model === "primary")).toHaveLength(2);
  });

  it("throws AllKeysExhaustedError with earliestRetryAt when no fallback", async () => {
    const h = harness(
      2,
      {
        status: 429,
        body: err(429, "RESOURCE_EXHAUSTED", "Too many requests", [{ "@type": RETRY_INFO, retryDelay: "20s" }]),
      },
      { m: fresh },
    );
    const e = await h.gemini.call(spec, { model: "m" }).catch((x) => x);
    expect(e).toBeInstanceOf(AllKeysExhaustedError);
    expect(e.earliestRetryAt).toBeGreaterThan(Date.now() + 19_000);
  });

  it("retries 503 at most twice, then tries the fallback", async () => {
    const h = harness(
      1,
      (_k, model) =>
        model === "m" ? { status: 503, body: err(503, "UNAVAILABLE", "The model is overloaded.") } : ok({ ok: true }),
      { m: fresh, fb: fresh },
    );
    const r = await h.gemini.call(spec, { model: "m", fallback: "fb" });
    expect(r.usedModel).toBe("fb");
    expect(h.calls.filter((c) => c.model === "m")).toHaveLength(3);
  });

  it("never sends the key in the URL or sampling params in the body", async () => {
    const h = harness(1, ok({ ok: true }), { m: fresh });
    await h.gemini.call(spec, { model: "m" });
    const gc = h.calls[0].body.generationConfig as Record<string, unknown>;
    expect(gc.temperature).toBeUndefined();
    expect(gc.topP).toBeUndefined();
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });
});

describe("capability probe chain (§10.4)", () => {
  const thinkingErr = {
    status: 400,
    body: err(400, "INVALID_ARGUMENT", "Thinking level is not supported for this model."),
  };

  it("walks minimal → low → budget 0 → none, advancing only on thinking errors", async () => {
    const h = harness(1, (_k, _m, body) => {
      const tc = (body.generationConfig as Record<string, unknown>).thinkingConfig as
        Record<string, unknown> | undefined;
      return tc?.thinkingBudget === 0 ? ok({ ok: true }) : thinkingErr;
    });
    const caps = await h.gemini.validateModel("m");
    expect(caps.thinking).toEqual({ kind: "budget", value: 0 });
    expect(caps.schema).toBe("responseSchema");
    expect(h.calls.map((c) => (c.body.generationConfig as Record<string, unknown>).thinkingConfig)).toEqual([
      { thinkingLevel: "minimal" },
      { thinkingLevel: "low" },
      { thinkingBudget: 0 },
    ]);
  });

  it("falls back to no thinkingConfig", async () => {
    const h = harness(1, (_k, _m, body) =>
      (body.generationConfig as Record<string, unknown>).thinkingConfig ? thinkingErr : ok({ ok: true }),
    );
    expect((await h.gemini.validateModel("m")).thinking).toEqual({ kind: "none" });
  });

  it("switches to promptOnly on schema errors and appends the schema to the system prompt", async () => {
    const h = harness(1, (_k, _m, body) =>
      (body.generationConfig as Record<string, unknown>).responseSchema
        ? { status: 400, body: err(400, "INVALID_ARGUMENT", "response_schema is not supported") }
        : ok({ ok: true }),
    );
    const caps = await h.gemini.validateModel("m");
    expect(caps).toMatchObject({ schema: "promptOnly", thinking: { kind: "level", value: "minimal" } });
    const last = h.calls.at(-1)!.body as { systemInstruction: { parts: { text: string }[] } };
    expect(last.systemInstruction.parts[0].text).toContain("JSON schema of the reply");
  });

  it("does not treat rate limits as capability failures", async () => {
    let n = 0;
    const h = harness(2, () =>
      n++ === 0 ? { status: 429, body: err(429, "RESOURCE_EXHAUSTED", "slow down") } : ok({ ok: true }),
    );
    expect((await h.gemini.validateModel("m")).thinking).toEqual({ kind: "level", value: "minimal" });
  });

  it("probes on first use and caches the result", async () => {
    const h = harness(1, ok({ ok: true }));
    await h.gemini.call(spec, { model: "m" });
    await h.gemini.call(spec, { model: "m" });
    expect(h.caps.m.thinking).toEqual({ kind: "level", value: "minimal" });
    expect(h.calls).toHaveLength(3);
  });

  it("essays use low thinking when minimal is the base config and remember it", async () => {
    const h = harness(1, ok({ ok: true }), { m: fresh });
    await h.gemini.call({ ...spec, essay: true }, { model: "m" });
    expect((h.calls[0].body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingLevel: "low",
    });
    expect(h.caps.m.essayThinking).toEqual({ kind: "level", value: "low" });
  });
});
