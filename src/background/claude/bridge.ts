// Chrome native messaging to the Claude bridge (src/native/host.*), which runs the user's own `claude -p` once per launch.
import { toBase64 } from "../../shared/base64";
import { ClaudeSetupError, ServerError } from "../gemini/errors";

export const BRIDGE_HOST = "com.autoapply.claude";

export interface BridgeRequest {
  system: string;
  prompt: string;
  /** Claude Code model alias and effort level; "" leaves Claude Code's default. */
  model: string;
  effort: string;
}

export interface BridgeReply {
  /** claude's exit code; 127: it couldn't be started, 2: the bridge refused the request. */
  code: number;
  /** claude's stdout: stream-json lines. */
  out: string;
  /** The end of claude's stderr. */
  err: string;
}

const SETUP = "run the setup command in AutoApply → AI";
const enc = (s: string) => toBase64(new TextEncoder().encode(s));
const dec = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

function disconnectError(message: string): Error {
  if (/not found/i.test(message)) return new ClaudeSetupError(`AutoApply's Claude bridge isn't installed: ${SETUP}.`);
  if (/forbidden/i.test(message))
    return new ClaudeSetupError(
      `The Claude bridge was set up for another copy of AutoApply (moved or reinstalled): ${SETUP} again.`,
    );
  if (/exited/i.test(message))
    return new ClaudeSetupError(`The Claude bridge stopped without answering: ${SETUP} again.`);
  return new ServerError(`Couldn't reach the Claude bridge: ${message || "it disconnected"}.`);
}

/** One `claude -p` run. Throws AbortError on abort, ClaudeSetupError when the bridge isn't usable. */
export function runBridge(req: BridgeRequest, timeoutMs: number, signal?: AbortSignal): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(BRIDGE_HOST);
    } catch {
      // without the optional nativeMessaging permission connectNative is missing
      return reject(
        new ClaudeSetupError("AutoApply isn't allowed to reach Claude Code yet: click Connect in AutoApply → AI."),
      );
    }
    let settled = false;
    // Disconnecting closes the bridge's stdin, which makes it stop claude.
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      port.disconnect();
      fn();
    };
    const onAbort = () => done(() => reject(new DOMException("Aborted", "AbortError")));
    const timer = setTimeout(
      () => done(() => reject(new ServerError(`Claude didn't answer within ${Math.round(timeoutMs / 1000)} s.`))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort);
    port.onMessage.addListener((m: { code: number; out: string; err: string }) =>
      done(() => resolve({ code: m.code, out: dec(m.out), err: dec(m.err) })),
    );
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? "";
      done(() => reject(disconnectError(message)));
    });
    port.postMessage([enc(req.system), enc(req.prompt), req.model, req.effort]);
  });
}
