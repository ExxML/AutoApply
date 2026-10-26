// Sites' verification emails (links and one-time codes), read from the YOLO inbox with the Gmail API, read-only.
import { session } from "../../shared/storage";

export class GmailAuthError extends Error {}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** An access token for the YOLO inbox; `interactive` shows Google's sign-in, else it renews silently or throws. */
export async function gmailToken(clientId: string, email: string, interactive: boolean): Promise<string> {
  const cached = await session.get<{ token: string; exp: number }>("gmailToken");
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!clientId) throw new GmailAuthError("Gmail isn't connected");
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    login_hint: email,
    ...(interactive ? {} : { prompt: "none" }),
  })}`;
  const back = await chrome.identity
    .launchWebAuthFlow({ url, interactive, ...(interactive ? {} : { timeoutMsForNonInteractive: 10_000 }) })
    .catch((e: Error) => {
      throw new GmailAuthError(e.message);
    });
  const h = new URLSearchParams(new URL(back ?? "about:blank").hash.slice(1));
  const token = h.get("access_token");
  if (!token) throw new GmailAuthError(h.get("error") ?? "Gmail sign-in failed");
  await session.set("gmailToken", { token, exp: Date.now() + Number(h.get("expires_in") ?? 3600) * 1000 });
  return token;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}

const fromB64url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export function bodyOf(p: Part): string {
  const own = /^text\/(html|plain)/.test(p.mimeType ?? "") && p.body?.data ? fromB64url(p.body.data) : "";
  return [own, ...(p.parts ?? []).map(bodyOf)].join("\n");
}

const RE_LINK = /verif|activat|confirm|validat|token|registr|reset|password|signup|sign-up|account/i;
const RE_NOT_LINK =
  /unsubscribe|privacy|terms|preferences|support|help|facebook|twitter|linkedin|instagram|youtube|\.(png|jpe?g|gif)\b/i;

/** The verification link or one-time code in an email body. */
export function extract(body: string, want: "link" | "code"): string | null {
  if (want === "link") {
    const urls = [...body.matchAll(/href=["']([^"']+)["']|(https?:\/\/[^\s"'<>]+)/g)].map((m) =>
      (m[1] ?? m[2]).replace(/&amp;/g, "&"),
    );
    return urls.find((u) => /^https?:/.test(u) && RE_LINK.test(u) && !RE_NOT_LINK.test(u)) ?? null;
  }
  const t = body
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
  return (
    /\b(?:code|passcode|pin|otp)\b[^A-Za-z0-9]{0,40}(?:is[^A-Za-z0-9]{0,5})?\b(\d{4,8}|[A-Z0-9]{6,8})\b/i.exec(
      t,
    )?.[1] ??
    /\b(\d{6})\b/.exec(t)?.[1] ??
    null
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the inbox for a message to `to` received after `since` that holds what `want`s; null after 5 minutes. */
export async function waitForEmail(
  token: () => Promise<string>,
  to: string,
  since: number,
  want: "link" | "code",
  timeoutMs = 300_000,
): Promise<string | null> {
  const api = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${API}/${path}`, { headers: { authorization: `Bearer ${await token()}` } });
    if (r.status === 401) throw new GmailAuthError("Gmail sign-in expired");
    if (!r.ok) throw new Error(`Gmail HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  const tried = new Set<string>();
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(10_000)) {
    const q = `to:${to} after:${Math.floor(since / 1000) - 120}`;
    const list = await api<{ messages?: { id: string }[] }>(`messages?maxResults=10&q=${encodeURIComponent(q)}`);
    for (const { id } of list.messages ?? []) {
      if (tried.has(id)) continue;
      tried.add(id);
      const m = await api<{ internalDate: string; payload: Part }>(`messages/${id}?format=full`);
      if (Number(m.internalDate) < since - 60_000) continue;
      const found = extract(bodyOf(m.payload), want);
      if (found) return found;
    }
  }
  return null;
}
