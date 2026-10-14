// §13.3 decision cache: LRU (2000 entries), 30-day TTL, keyed by signature + profileVersion.
import { hash } from "../shared/hash";
import type { CachedDecision } from "../shared/types";

export type CacheEntry = CachedDecision & { lastUsedAt: number };

export const CACHE_MAX = 2000;
export const CACHE_TTL = 30 * 24 * 3600 * 1000;

export class DecisionCache {
  constructor(
    public entries: Record<string, CacheEntry>,
    private persist: (entries: Record<string, CacheEntry>) => void = () => {},
    private now: () => number = Date.now,
  ) {}

  /** `signature` already carries "@host" when the question names the company (see content/index.ts). */
  static key(signature: string, profileVersion: string): string {
    return hash(`${signature}|${profileVersion}`);
  }

  lookup(signatures: string[], profileVersion: string): Record<string, CachedDecision> {
    const now = this.now();
    const out: Record<string, CachedDecision> = {};
    let touched = false;
    for (const sig of signatures) {
      const k = DecisionCache.key(sig, profileVersion);
      const e = this.entries[k];
      if (!e) continue;
      if (now - e.savedAt > CACHE_TTL) {
        delete this.entries[k];
        touched = true;
        continue;
      }
      e.lastUsedAt = now;
      touched = true;
      const { lastUsedAt: _, ...decision } = e;
      out[sig] = decision;
    }
    if (touched) this.persist(this.entries);
    return out;
  }

  store(items: { signature: string; decision: CachedDecision }[], profileVersion: string) {
    const now = this.now();
    for (const { signature, decision } of items) {
      if (decision.action !== "fill" || decision.source !== "ai") continue;
      this.entries[DecisionCache.key(signature, profileVersion)] = { ...decision, savedAt: now, lastUsedAt: now };
    }
    const keys = Object.keys(this.entries);
    if (keys.length > CACHE_MAX) {
      keys
        .sort((a, b) => this.entries[a].lastUsedAt - this.entries[b].lastUsedAt)
        .slice(0, keys.length - CACHE_MAX)
        .forEach((k) => delete this.entries[k]);
    }
    this.persist(this.entries);
  }

  clear() {
    this.entries = {};
  }
}
