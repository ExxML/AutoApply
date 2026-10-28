// Claude through the user's own Claude Code and Claude plan, no API key (DECISIONS.md): same call contract as Gemini.
import { CLAUDE_ARG, type ClaudeTask } from "../../shared/settings";
import type { ClaudeModel } from "../../shared/types";
import { parseJsonReply, promptWithSchema, Semaphore, type CallResult, type CallSpec } from "../gemini/client";
import {
  BadOutputError,
  BlockedError,
  ClaudeLimitError,
  ClaudeSetupError,
  ModelGoneError,
  ServerError,
} from "../gemini/errors";
import { LIST_MODELS, runBridge, type BridgeReply } from "./bridge";

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
  usage?: unknown;
  error?: string;
  rate_limit_info?: { status?: string; resetsAt?: number };
  response?: { subtype?: string; error?: string; response?: { models?: unknown } };
}

const SIGNED_OUT = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error"]);

const readLines = (r: BridgeReply) =>
  r.out.split("\n").flatMap((l): Line[] => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

/** Why claude gave no answer at all. */
function failure(r: BridgeReply): Error {
  if (r.code === 127)
    return new ClaudeSetupError(
      "Claude Code wasn't found where setup saw it: run the setup command in AutoApply → AI again.",
    );
  if (/unknown option/i.test(r.err))
    return new ClaudeSetupError("Claude Code is too old for AutoApply: run `claude update`.");
  return new ServerError(`Claude Code failed: ${r.err.trim().slice(-300) || `exit code ${r.code}`}`);
}

/** claude's reply text and model, or the error it ended with. */
export function readReply(r: BridgeReply, model: string): { text: string; model: string; usage?: unknown } {
  const lines = readLines(r);
  const res = lines.findLast((l) => l.type === "result");
  if (!res) throw failure(r);
  if (!res.is_error && res.subtype === "success") {
    if (res.stop_reason === "max_tokens") throw new BadOutputError("Response truncated (max_tokens)", true);
    if (res.stop_reason === "refusal") throw new BlockedError("Claude declined this request");
    return { text: res.result ?? "", model: Object.keys(res.modelUsage ?? {})[0] ?? "", usage: res.usage };
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

/**
 * The models in Claude Code's initialize reply, in its order. Its "default" entry is the "" setting, and a value the
 * bridge won't pass on (CLAUDE_ARG, e.g. "sonnet[1m]") is left out.
 */
export function readModels(r: BridgeReply): ClaudeModel[] {
  if (r.code === 2 && r.err.includes(LIST_MODELS))
    throw new ServerError(
      "AutoApply's Claude bridge predates model lists: run the setup command in AutoApply → AI again to list them.",
    );
  const res = readLines(r).findLast((l) => l.type === "control_response")?.response;
  if (!res) throw failure(r);
  const models = res.response?.models;
  if (res.subtype !== "success" || !Array.isArray(models))
    throw new ServerError(`Claude Code didn't list its models: ${res.error || "run `claude update`"}.`);
  const out = new Map<string, ClaudeModel>();
  for (const m of models as Record<string, unknown>[]) {
    const value = m?.value;
    if (typeof value !== "string" || !value || value === "default" || !CLAUDE_ARG.test(value) || out.has(value))
      continue;
    const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
    out.set(value, { value, displayName: str(m.displayName, value), description: str(m.description, "") });
  }
  return [...out.values()];
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
      // Claude Code caches the system prompt across runs, so the candidate's data goes there to be reused.
      system:
        (spec.schema ? promptWithSchema(spec.system, spec.schema) : spec.system) +
        (spec.context ? `\n\nCandidate data (JSON):\n${JSON.stringify(spec.context)}` : ""),
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
          log("[claude] usage", r.model, JSON.stringify(r.usage));
          return { data, usedModel: r.model || task.model || "claude", keyLabel: "Claude" };
        } catch (e) {
          if (e instanceof ClaudeSetupError) deps.onSetupError?.();
          if (retried || !(e instanceof BadOutputError) || e.truncated) throw e;
        }
      }
    });
  }

  /** The models Claude Code offers the user's sign-in; asks nothing of the model, so it uses no plan limits. */
  async function listModels(signal?: AbortSignal): Promise<ClaudeModel[]> {
    return readModels(await send({ system: "", prompt: "", model: LIST_MODELS, effort: "" }, 30000, signal));
  }

  return { call, listModels };
}

export type Claude = ReturnType<typeof createClaude>;
