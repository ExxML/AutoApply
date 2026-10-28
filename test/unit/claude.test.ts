import { describe, expect, it, vi } from "vitest";
import type { BridgeReply, BridgeRequest } from "../../src/background/claude/bridge";
import { LIST_MODELS } from "../../src/background/claude/bridge";
import { createClaude } from "../../src/background/claude/client";
import {
  BadOutputError,
  ClaudeLimitError,
  ClaudeSetupError,
  ModelGoneError,
  ServerError,
} from "../../src/background/gemini/errors";
import { VALIDATION_SCHEMA, ValidationZ } from "../../src/background/gemini/schemas";
import { installerScript, setupCommand } from "../../src/options/claudeSetup";
import { SettingsSchema } from "../../src/shared/settings";

// Real-shaped stream-json lines (claude -p --output-format stream-json --verbose, Claude Code 2.1.311)
const init = { type: "system", subtype: "init", tools: [], model: "claude-haiku-5-5" };
const ok = (result: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "end_turn",
  api_error_status: null,
  result,
  modelUsage: { "claude-haiku-5-5": { inputTokens: 2 } },
});
const failed = (result: string, status: number | null = null) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: status,
  result,
});
const reply = (...lines: object[]): BridgeReply => ({
  code: 0,
  out: lines.map((l) => JSON.stringify(l)).join("\n"),
  err: "",
});

const spec = {
  system: "SYS",
  payload: { ping: true },
  schema: VALIDATION_SCHEMA,
  validate: (d: unknown) => ValidationZ.parse(d),
  timeoutMs: 1000,
};
const task = { model: "haiku", effort: "low" } as const;

function client(...replies: (BridgeReply | Error)[]) {
  const reqs: BridgeRequest[] = [];
  const timeouts: number[] = [];
  const onSetupError = vi.fn();
  const send = vi.fn(async (req: BridgeRequest, timeoutMs: number) => {
    reqs.push(req);
    timeouts.push(timeoutMs);
    const r = replies.shift();
    if (!r) throw new Error("no more replies");
    if (r instanceof Error) throw r;
    return r;
  });
  return { claude: createClaude({ concurrency: () => 2, onSetupError, send }), reqs, timeouts, send, onSetupError };
}

describe("Claude client", () => {
  it("sends the schema in the system prompt, the payload as JSON, the task's model/effort; parses the reply", async () => {
    const c = client(reply(init, ok('{"ok":true}')));
    const r = await c.claude.call(spec, task);
    expect(r).toEqual({ data: { ok: true }, usedModel: "claude-haiku-5-5", keyLabel: "Claude" });
    expect(c.reqs[0]).toEqual({
      system: `SYS\n\nJSON schema of the reply:\n${JSON.stringify(VALIDATION_SCHEMA)}`,
      prompt: '{"ping":true}',
      model: "haiku",
      effort: "low",
    });
    expect(c.timeouts[0]).toBe(2000);
  });

  it("puts the context in the system prompt, which Claude Code caches across runs", async () => {
    const c = client(reply(ok('{"ok":true}')));
    await c.claude.call({ ...spec, context: { profile: { x: 1 } } }, task);
    expect(c.reqs[0].system).toBe(
      `SYS\n\nJSON schema of the reply:\n${JSON.stringify(VALIDATION_SCHEMA)}\n\nCandidate data (JSON):\n{"profile":{"x":1}}`,
    );
    expect(c.reqs[0].prompt).toBe('{"ping":true}');
  });

  it("takes the JSON object out of a fence or prose", async () => {
    const c = client(reply(ok('Here you go:\n```json\n{"ok": true}\n```')));
    expect((await c.claude.call(spec, task)).data).toEqual({ ok: true });
  });

  it("asks once more on a bad reply, then gives up with BadOutputError", async () => {
    const c = client(reply(ok("not json")), reply(ok('{"ok":true}')));
    expect((await c.claude.call(spec, task)).data).toEqual({ ok: true });
    const d = client(reply(ok("nope")), reply(ok('{"wrong":1}')));
    await expect(d.claude.call(spec, task)).rejects.toBeInstanceOf(BadOutputError);
    expect(d.send).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a truncated reply", async () => {
    const c = client(reply({ ...ok('{"ok":'), stop_reason: "max_tokens" }));
    await expect(c.claude.call(spec, task)).rejects.toMatchObject({ truncated: true });
    expect(c.send).toHaveBeenCalledTimes(1);
  });

  it("usage limit → ClaudeLimitError at the rate-limit event's reset time", async () => {
    const c = client(
      reply(
        { type: "assistant", error: "rate_limit", message: { content: [] } },
        { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1793088000 } },
        failed("You've hit your limit", 429),
      ),
    );
    const e = await c.claude.call(spec, task).catch((x) => x);
    expect(e).toBeInstanceOf(ClaudeLimitError);
    expect(e.earliestRetryAt).toBe(1793088000 * 1000);
    expect(e.message).toBe("Claude usage limit reached.");
    expect(c.onSetupError).not.toHaveBeenCalled();
  });

  it("a usage limit without a reset time retries in half an hour", async () => {
    const c = client(reply({ type: "assistant", error: "rate_limit" }, failed("limit")));
    const e = await c.claude.call(spec, task).catch((x) => x);
    expect(e.earliestRetryAt).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  it("an allowed_warning rate-limit event on a success is ignored", async () => {
    const c = client(
      reply({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }, ok('{"ok":true}')),
    );
    expect((await c.claude.call(spec, task)).data).toEqual({ ok: true });
  });

  it("signed out → ClaudeSetupError, and setup is marked needed", async () => {
    const c = client(
      reply({ type: "assistant", error: "authentication_failed" }, failed("Not logged in · Please run /login", 401)),
    );
    const e = await c.claude.call(spec, task).catch((x) => x);
    expect(e).toBeInstanceOf(ClaudeSetupError);
    expect(e.message).toMatch(/sign in with \/login/);
    expect(c.onSetupError).toHaveBeenCalledTimes(1);
  });

  it("a model the plan can't use → ModelGoneError naming it", async () => {
    const c = client(reply({ type: "assistant", error: "model_not_found" }, failed("model not found", 404)));
    const e = await c.claude.call(spec, { model: "fable", effort: "" }).catch((x) => x);
    expect(e).toBeInstanceOf(ModelGoneError);
    expect(e.message).toMatch(/can't use fable/);
  });

  it("bridge failures: claude missing, too old, other", async () => {
    const missing = client({ code: 127, out: "", err: "not found" });
    await expect(missing.claude.call(spec, task)).rejects.toThrow(/wasn't found/);
    expect(missing.onSetupError).toHaveBeenCalled();
    const old = client({ code: 1, out: "", err: "error: unknown option '--safe-mode'" });
    await expect(old.claude.call(spec, task)).rejects.toThrow(/claude update/);
    const other = client({ code: 1, out: "", err: "boom" });
    await expect(other.claude.call(spec, task)).rejects.toBeInstanceOf(ServerError);
    expect(other.onSetupError).not.toHaveBeenCalled();
  });

  it("passes the bridge's own errors through (abort, setup)", async () => {
    const c = client(new DOMException("Aborted", "AbortError"));
    await expect(c.claude.call(spec, task)).rejects.toMatchObject({ name: "AbortError" });
    const d = client(new ClaudeSetupError("not installed"));
    await expect(d.claude.call(spec, task)).rejects.toThrow("not installed");
    expect(d.onSetupError).toHaveBeenCalled();
  });
});

describe("Claude model list", () => {
  // Real-shaped initialize reply (claude -p --input-format stream-json, Claude Code 2.1.312), trimmed.
  const listed = (models: unknown, subtype = "success") =>
    reply(
      { type: "autocompact_state", value: { enabled: true } },
      { type: "control_response", response: { subtype, request_id: "models", response: { models, pid: 1 } } },
    );
  const MODELS = [
    { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday tasks" },
    { value: "opus", displayName: "Opus 5.5", description: "Best for everyday, complex tasks" },
    { value: "haiku", displayName: "Haiku 5.5", description: "Fastest for quick answers" },
    { value: "sonnet[1m]", displayName: "Sonnet 5.5 (1M context)", description: "" },
    { value: "claude-opus-4-8", displayName: "Opus 4.8" },
    { value: "opus", displayName: "Opus again" },
    { value: 7 },
    null,
  ];

  it("asks the bridge for the list and keeps the models it can pass on, in Claude Code's order", async () => {
    const c = client(listed(MODELS));
    expect(await c.claude.listModels()).toEqual([
      { value: "opus", displayName: "Opus 5.5", description: "Best for everyday, complex tasks" },
      { value: "haiku", displayName: "Haiku 5.5", description: "Fastest for quick answers" },
      { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
    ]);
    expect(c.reqs[0]).toEqual({ system: "", prompt: "", model: LIST_MODELS, effort: "" });
  });

  it("a bridge set up before model lists says to run setup again; nothing marks setup needed", async () => {
    const c = client({ code: 2, out: "", err: `bad model or effort: ${LIST_MODELS}` });
    await expect(c.claude.listModels()).rejects.toThrow(/run the setup command .* again/);
    expect(c.onSetupError).not.toHaveBeenCalled();
  });

  it("failures: claude missing, too old, an error reply", async () => {
    await expect(client({ code: 127, out: "", err: "" }).claude.listModels()).rejects.toBeInstanceOf(ClaudeSetupError);
    await expect(client({ code: 1, out: "", err: "unknown option '--safe-mode'" }).claude.listModels()).rejects.toThrow(
      /claude update/,
    );
    await expect(client(listed(undefined)).claude.listModels()).rejects.toThrow(/didn't list its models/);
    await expect(client(listed(MODELS, "error")).claude.listModels()).rejects.toBeInstanceOf(ServerError);
  });

  it("settings keep any model the bridge accepts, so listed models need no extension update", () => {
    const parse = (model: string) => SettingsSchema.parse({ claude: { fill: { model, effort: "low" } } }).claude.fill;
    expect(parse("claude-opus-9-1")).toEqual({ model: "claude-opus-9-1", effort: "low" });
    expect(parse("fable")).toEqual({ model: "fable", effort: "low" });
    expect(parse("sonnet[1m]").model).toBe("");
    expect(parse("--tools=Bash").model).toBe("");
  });
});

describe("Claude bridge setup command", () => {
  it.each(["win", "mac", "linux"] as const)(
    "%s: decodes to the installer, which embeds the host and this extension's ID",
    (os) => {
      const cmd = setupCommand(os, "abcdefghijklmnopabcdefghijklmnop");
      const b64 = /'([A-Za-z0-9+/=]{100,})'/.exec(cmd)![1];
      const script = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      expect(script).toBe(installerScript(os, "abcdefghijklmnopabcdefghijklmnop"));
      expect(script).toContain('"allowed_origins":["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]');
      expect(script).toContain(
        os === "win" ? "AutoApply's Claude bridge (Windows)" : "AutoApply's Claude bridge (macOS/Linux)",
      );
    },
  );
});
