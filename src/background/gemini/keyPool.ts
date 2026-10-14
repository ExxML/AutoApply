import type { ApiKeyEntry, KeyState } from "../../shared/types";
import { nextMidnightPacific } from "../../shared/time";
import type { Classified } from "./errors";

const DAY = 24 * 3600 * 1000;

/** §10.5 key pool: LRU selection over healthy keys, with per-key and per-model penalties. */
export class KeyPool {
  keys: ApiKeyEntry[] = [];
  state: Record<string, KeyState> = {};

  constructor(
    keys: ApiKeyEntry[],
    state: Record<string, KeyState>,
    private onChange: (state: Record<string, KeyState>) => void = () => {},
    private now: () => number = Date.now,
  ) {
    this.setKeys(keys, state);
  }

  setKeys(keys: ApiKeyEntry[], state = this.state) {
    this.keys = keys;
    this.state = {};
    for (const k of keys) this.state[k.id] = state[k.id] ?? { successCount: 0, errorCount: 0 };
  }

  private st(id: string): KeyState {
    return (this.state[id] ??= { successCount: 0, errorCount: 0 });
  }

  isAvailable(id: string, model: string, now = this.now()): boolean {
    const s = this.st(id);
    const pm = s.perModel?.[model];
    return (
      !s.invalid &&
      (s.cooldownUntil ?? 0) <= now &&
      (pm?.exhaustedUntil ?? 0) <= now &&
      (pm?.unavailableUntil ?? 0) <= now
    );
  }

  /** Least-recently-used healthy key for `model`; marks it used before returning. */
  select(model: string, preferId?: string): ApiKeyEntry | null {
    const now = this.now();
    const ok = this.keys.filter((k) => this.isAvailable(k.id, model, now));
    if (!ok.length) return null;
    const pick =
      ok.find((k) => k.id === preferId) ??
      ok.reduce((a, b) => ((this.st(b.id).lastUsedAt ?? 0) < (this.st(a.id).lastUsedAt ?? 0) ? b : a));
    this.st(pick.id).lastUsedAt = now;
    this.onChange(this.state);
    return pick;
  }

  record(id: string, model: string, c: Classified, httpStatus: number) {
    const s = this.st(id);
    const now = this.now();
    if (c.kind === "success") {
      s.successCount++;
      delete s.invalid;
    } else {
      s.errorCount++;
      s.lastError = { status: httpStatus, message: c.message.slice(0, 300), at: now };
    }
    if (c.kind === "rotateKey") {
      const pm = ((s.perModel ??= {})[model] ??= {});
      if (c.effect === "invalid") s.invalid = { reason: c.message.slice(0, 200), at: now };
      else if (c.effect === "unavailable") pm.unavailableUntil = now + DAY;
      else if (c.effect === "exhausted") pm.exhaustedUntil = nextMidnightPacific(now);
      else s.cooldownUntil = now + (c.retryDelayMs ?? 30_000) + Math.random() * 2000;
    }
    this.onChange(this.state);
  }

  /** 404: the model is gone for every key. */
  markModelGone(model: string) {
    const until = this.now() + DAY;
    for (const k of this.keys) ((this.st(k.id).perModel ??= {})[model] ??= {}).unavailableUntil = until;
    this.onChange(this.state);
  }

  /** Earliest time any non-invalid, non-unavailable key becomes usable again for `model`. */
  earliestRetryAt(model: string): number | undefined {
    const now = this.now();
    let best: number | undefined;
    for (const k of this.keys) {
      const s = this.st(k.id);
      const pm = s.perModel?.[model];
      if (s.invalid || (pm?.unavailableUntil ?? 0) > now) continue;
      const t = Math.max(s.cooldownUntil ?? 0, pm?.exhaustedUntil ?? 0);
      if (best === undefined || t < best) best = t;
    }
    return best;
  }

  reasons(model: string): Record<string, string> {
    return Object.fromEntries(this.keys.map((k) => [k.label, keyStatusText(this.st(k.id), model, this.now())]));
  }

  healthyCount(model: string | null): number {
    const now = this.now();
    return this.keys.filter((k) => (model ? this.isAvailable(k.id, model, now) : !this.st(k.id).invalid)).length;
  }
}

/** Status chip text for a key (§8.1 AI section). */
export function keyStatusText(s: KeyState | undefined, model: string | null, now = Date.now()): string {
  if (!s) return "Healthy";
  if (s.invalid) return "Invalid key";
  const pm = model ? s.perModel?.[model] : undefined;
  const t = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (pm?.unavailableUntil && pm.unavailableUntil > now) return "Model unavailable on this key";
  if (pm?.exhaustedUntil && pm.exhaustedUntil > now) return `Daily quota used for ${model} until 00:00 PT`;
  if (s.cooldownUntil && s.cooldownUntil > now) return `Cooling down until ${t(s.cooldownUntil)}`;
  return "Healthy";
}
