// Site accounts YOLO creates. Passwords are AES-GCM encrypted with a key generated non-extractable and kept in
// IndexedDB: copied storage or an export can't be decrypted, yet runs need no passphrase after a browser restart.
import { normalize } from "../../shared/normalize";
import { createStorage } from "../../shared/storage";
import { siteOf } from "./gmail";

const store = createStorage("background");
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function idb<T>(fn: (s: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("autoapply-vault", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction("keys", mode).objectStore("keys"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

let cached: Promise<CryptoKey> | undefined;
/** The device key, created on first use. */
export function deviceKey(): Promise<CryptoKey> {
  return (cached ??= (async () => {
    const k = await idb<CryptoKey | undefined>((s) => s.get("vault"), "readonly");
    if (k) return k;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idb((s) => s.put(key, "vault"), "readwrite");
    return key;
  })());
}

export async function encrypt(key: CryptoKey, plain: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decrypt(key: CryptoKey, e: { iv: string; ct: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv) }, key, unb64(e.ct));
  return new TextDecoder().decode(pt);
}

/** 18 characters with every class most ATS password rules ask for; symbols safe in any form. */
export function newPassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%^*_-"];
  const all = sets.join("");
  const pick = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const chars = [...sets.map(pick), ...Array.from({ length: 14 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export async function getAccount(site: string): Promise<{ email: string; password: string } | null> {
  const e = (await store.get("vault"))[site];
  return e ? { email: e.email, password: await decrypt(await deviceKey(), e) } : null;
}

async function saveAccount(site: string, email: string, password: string) {
  const vault = await store.get("vault");
  vault[site] = { email, ...(await encrypt(await deviceKey(), password)), createdAt: Date.now() };
  await store.set({ vault });
}

/** Saved before the sign-up form is submitted, so a crash mid-signup never loses a password. */
export async function createAccount(site: string, email: string): Promise<{ email: string; password: string }> {
  const password = newPassword();
  await saveAccount(site, email, password);
  return { email, password };
}

/** An account the user made themselves: YOLO signs in with it instead of signing up. False if the site has one. */
export async function addAccount(site: string, email: string, password: string): Promise<boolean> {
  if ((await store.get("vault"))[site]) return false;
  await saveAccount(site, email, password);
  return true;
}

/**
 * The account key a page address names, as content/yolo/auth.ts siteKey names it on that page: a Workday tenant's, a
 * SuccessFactors company's (null without ?company=: no other company's account), else the host's.
 * shortcut: copies siteKey's address rules, move both into src/shared when auth.ts is next changed.
 */
export function accountSite(href: string): string | null {
  const u = new URL(href);
  const h = u.hostname.toLowerCase();
  if (/\.myworkday(jobs|site)\.com$/.test(h)) return `workday:${h.split(".")[0]}`;
  if (!/(^|\.)(successfactors\.(com|eu)|ns2cloud\.com)$/.test(h)) return h.replace(/^www\./, "");
  const company = [...u.searchParams].find(([k]) => k.toLowerCase() === "company")?.[1]?.toLowerCase();
  return company ? `sf:${h}:${company}` : null;
}

/**
 * The key a run's account is saved under, from the page's key (accountSite/siteKey) and the run's company. An address
 * that names the company (a Workday tenant, a SuccessFactors company) keys it; else the company on the page's site:
 * one host can serve many companies' separate accounts (UKG's signin-ca.ultipro.ca, Dayforce's dfid.dayforcehcm.com)
 * and sign up and sign in on sibling hosts. No company: the page's key, as before.
 */
export function accountKey(page: string, company: string): string {
  const c = normalize(company)
    .replace(/\b(inc|incorporated|llc|llp|ltd|limited|corp|corporation|co|plc|gmbh|ulc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!c || page.startsWith("workday:") || /^sf:.+:.+$/.test(page)) return page;
  return `${siteOf(page.replace(/^sf:|:$/g, ""))}|${c}`;
}

export async function deleteAccount(site: string) {
  const vault = await store.get("vault");
  delete vault[site];
  await store.set({ vault });
}
