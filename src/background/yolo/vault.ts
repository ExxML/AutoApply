// Site accounts YOLO creates. Passwords are AES-GCM encrypted with a key generated non-extractable and kept in
// IndexedDB: copied storage or an export can't be decrypted, yet runs need no passphrase after a browser restart.
import { createStorage } from "../../shared/storage";

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

/** Saved before the sign-up form is submitted, so a crash mid-signup never loses a password. */
export async function createAccount(site: string, email: string): Promise<{ email: string; password: string }> {
  const password = newPassword();
  const vault = await store.get("vault");
  vault[site] = { email, ...(await encrypt(await deviceKey(), password)), createdAt: Date.now() };
  await store.set({ vault });
  return { email, password };
}

export async function deleteAccount(site: string) {
  const vault = await store.get("vault");
  delete vault[site];
  await store.set({ vault });
}
