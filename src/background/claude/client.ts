// Claude through the user's own Claude Code and Claude plan, no API key (DECISIONS.md): same call contract as Gemini.
import type { ClaudeTask } from "../../shared/settings";
import { parseJsonReply, promptWithSchema, Semaphore, type CallResult, type CallSpec } from "../gemini/client";
import {
  BadOutputError,
  BlockedError,
  ClaudeLimitError,
  ClaudeSetupError,
  ModelGoneError,
  ServerError,
} from "../gemini/errors";
import { runBridge, type BridgeReply } from "./bridge";

export interface ClaudeDeps {
  concurrency: () => number;
  /** When true, prompts/responses are logged to the SW console. */
  debug?: () => boolean;
  /** Claude Code became unusable (bridge missing, signed out): setup is needed again. */
  onSetupError?: () => void;
  send?: typeof runBridge;
}

/** The stream-json lines read: the result, the assistant message's error category, and the rate-limit event. */
interface Line {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string | null;
  api_error_status?: number | null;
  modelUsage?: Record<string, unknown>;
  error?: string;
  rate_limit_info?: { status?: string; resetsAt?: number };
}

const SIGNED_OUT = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error"]);

/** claude's reply text and model, or the error it ended with. */
export function readReply(r: BridgeReply, model: string): { text: string; model: string } {
  const lines = r.out.split("\n").flatMap((l): Line[] => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const res = lines.findLast((l) => l.type === "result");
  if (!res) {
    if (r.code === 127)
      throw new ClaudeSetupError(
        "Claude Code wasn't found where setup saw it: run the setup command in AutoApply → AI again.",
      );
    if (/unknown option/i.test(r.err))
      throw new ClaudeSetupError("Claude Code is too old for AutoApply: run `claude update`.");
    throw new ServerError(`Claude Code failed: ${r.err.trim().slice(-300) || `exit code ${r.code}`}`);
  }
  if (!res.is_error && res.subtype === "success") {
    if (res.stop_reason === "max_tokens") throw new BadOutputError("Response truncated (max_tokens)", true);
    if (res.stop_reason === "refusal") throw new BlockedError("Claude declined this request");
    return { text: res.result ?? "", model: Object.keys(res.modelUsage ?? {})[0] ?? "" };
  }
  const msg = res.result || res.errors?.join("; ") || "";
  const category = lines.findLast((l) => l.type === "assistant" && l.error)?.error;
  const limit = lines.findLast((l) => l.type === "rate_limit_event" && l.rate_limit_info?.status === "rejected");
  if (limit || category === "rate_limit" || res.api_error_status === 429)
    throw new ClaudeLimitError((limit?.rate_limit_info?.resetsAt ?? Date.now() / 1000 + 30 * 60) * 1000);
  if (SIGNED_OUT.has(category ?? "") || res.api_error_status === 401 || res.api_error_status === 403)
    throw new ClaudeSetupError(
      `Claude Code isn't signed in to a Claude plan (${msg}): run \`claude\` in a terminal and sign in with /login.`,
    );
  if (category === "model_not_found") {
    const e = new ModelGoneError(model);
    e.message = `Your Claude plan can't use ${model || "the default model"}: choose another model in AutoApply → AI.`;
    throw e;
  }
  throw new ServerError(`Claude: ${msg || category || "unknown error"}`);
}

export function createClaude(deps: ClaudeDeps) {
  const sem = new Semaphore(deps.concurrency);
  const send = deps.send ?? runBridge;
  const log = (...a: unknown[]) => {
    if (deps.debug?.()) console.log(...a);
  };

  /** One reply, validated; a bad one is asked for once more. */
  async function call<T>(spec: CallSpec<T>, task: ClaudeTask): Promise<CallResult<T>> {
    const req = {
      // shortcut: the schema is only written into the prompt, with zod checking the reply. --json-schema would
      // constrain it but costs an extra tool turn and a Gemini→JSON-Schema conversion; upgrade if replies drift.
      system: spec.schema ? promptWithSchema(spec.system, spec.schema) : spec.system,
      prompt: typeof spec.payload === "string" ? spec.payload : JSON.stringify(spec.payload),
      ...task,
    };
    return sem.run(async () => {
      for (let retried = false; ; retried = true) {
        log("[claude] request", task.model || "default", req.prompt.slice(0, 4000));
        try {
          // Twice the timeout: each call starts Claude Code afresh.
          const r = readReply(await send(req, spec.timeoutMs * 2, spec.signal), task.model);
          // Every reply is one JSON object; drop any prose or fence around it.
          const data = parseJsonReply(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1), spec.validate);
          log("[claude] response", r.model, JSON.stringify(data).slice(0, 4000));
          return { data, usedModel: r.model || task.model || "claude", keyLabel: "Claude" };
        } catch (e) {
          if (e instanceof ClaudeSetupError) deps.onSetupError?.();
          if (retried || !(e instanceof BadOutputError) || e.truncated) throw e;
        }
      }
    });
  }

  return { call };
}

export type Claude = ReturnType<typeof createClaude>;
