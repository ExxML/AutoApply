// §10.6 error classification plus the error types callGemini throws.

export type Classified =
  | { kind: "success" }
  | {
      kind: "rotateKey";
      effect: "invalid" | "unavailable" | "exhausted" | "cooldown";
      message: string;
      retryDelayMs?: number;
    }
  | { kind: "serverTransient"; message: string }
  | { kind: "capability"; what: "thinking" | "schema"; message: string }
  | { kind: "modelGone"; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "badRequest"; message: string };

const BLOCKED_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "SPII", "BLOCKLIST", "RECITATION", "OTHER"]);

interface ErrorBody {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  details?: unknown;
}

type Detail = {
  "@type"?: string;
  reason?: string;
  retryDelay?: string;
  violations?: { quotaId?: string; quotaMetric?: string; quotaValue?: string | number }[];
};

function readError(body: unknown): { status: string; message: string; details: Detail[] } {
  const e = (body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null) as
    ErrorBody | null | undefined;
  return {
    status: typeof e?.status === "string" ? e.status : "",
    message: typeof e?.message === "string" ? e.message : typeof body === "string" ? body : "",
    details: Array.isArray(e?.details) ? (e.details.filter((d) => d && typeof d === "object") as Detail[]) : [],
  };
}

/** Parses "30s" / "1.5s" into ms. */
function retryDelayMs(details: Detail[]): number | undefined {
  for (const d of details) {
    const m = typeof d.retryDelay === "string" ? /^([\d.]+)s$/.exec(d.retryDelay) : null;
    if (m) return Math.round(parseFloat(m[1]) * 1000);
  }
  return undefined;
}

/**
 * Classify an HTTP result. `status` 0 means a network error or timeout.
 * For 200 responses, `body` is the parsed generateContent response.
 */
export function classify(status: number, body: unknown): Classified {
  if (status === 200) {
    const b = body as {
      promptFeedback?: { blockReason?: string };
      candidates?: { finishReason?: string }[];
    } | null;
    const block = b?.promptFeedback?.blockReason;
    const finish = b?.candidates?.[0]?.finishReason;
    if (block) return { kind: "blocked", message: `Blocked: ${block}` };
    if (finish && BLOCKED_FINISH.has(finish)) return { kind: "blocked", message: `Blocked: ${finish}` };
    return { kind: "success" };
  }
  const { status: st, message, details } = readError(body);
  const msg = message || `HTTP ${status}`;
  if (status === 0 || status === 408 || status >= 500) return { kind: "serverTransient", message: msg };
  if (status === 401 || status === 402 || status === 403) return { kind: "rotateKey", effect: "invalid", message: msg };
  if (status === 400) {
    if ((st === "INVALID_ARGUMENT" && /api key/i.test(msg)) || details.some((d) => d.reason === "API_KEY_INVALID"))
      return { kind: "rotateKey", effect: "invalid", message: msg };
    if (st === "FAILED_PRECONDITION") return { kind: "rotateKey", effect: "unavailable", message: msg };
    if (/thinking/i.test(msg)) return { kind: "capability", what: "thinking", message: msg };
    if (/response_?schema|schema/i.test(msg)) return { kind: "capability", what: "schema", message: msg };
    return { kind: "badRequest", message: msg };
  }
  if (status === 429) {
    const violations = details.flatMap((d) => d.violations ?? []);
    if (/limit: ?0\b/i.test(msg) || violations.some((v) => v.quotaValue !== undefined && Number(v.quotaValue) === 0))
      return { kind: "rotateKey", effect: "unavailable", message: msg };
    if (/per ?day|daily|PerDay/i.test(msg) || violations.some((v) => /per ?day|daily|PerDay/i.test(v.quotaId ?? "")))
      return { kind: "rotateKey", effect: "exhausted", message: msg };
    return { kind: "rotateKey", effect: "cooldown", message: msg, retryDelayMs: retryDelayMs(details) };
  }
  if (status === 404) return { kind: "modelGone", message: msg };
  return { kind: "badRequest", message: msg };
}

export class AllKeysExhaustedError extends Error {
  constructor(
    public model: string,
    public earliestRetryAt: number | undefined,
    public reasonsPerKey: Record<string, string>,
  ) {
    super(`All API keys are rate-limited for ${model}.`);
  }
}
export class NoKeysError extends Error {
  constructor() {
    super("No API key. Add one in settings.");
  }
}
export class BlockedError extends Error {}
export class BadOutputError extends Error {
  constructor(
    message: string,
    public truncated = false,
  ) {
    super(message);
  }
}
export class ModelGoneError extends Error {
  constructor(public model: string) {
    super(`Model ${model} no longer exists; choose another.`);
  }
}
export class BadRequestError extends Error {}
export class ServerError extends Error {}
