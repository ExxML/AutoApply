// @vitest-environment node
// The Claude bridge hosts (src/native) end to end: framed request in, framed reply out, against a fake `claude`.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../src/native");
const win = process.platform === "win32";
// Not Git Bash on Windows: MSYS hands native programs a stdin that never ends. host.sh is for macOS/Linux.
const hasSh = !win && spawnSync("sh", ["-c", "true"]).status === 0;

// The fake echoes its argv and stdin back as a stream-json result line (a control_response when listing models), or
// sleeps when asked to.
const FAKE = `
const fs = require("fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
if (args.includes("--input-format")) {
  console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", response: { args, stdin } } }));
  process.exit(0);
}
const sys = fs.readFileSync(args.find((a) => a.startsWith("--system-prompt-file=")).split("=").slice(1).join("="), "utf8");
if (stdin === "SLEEP") { fs.writeFileSync(process.env.PIDFILE, String(process.pid)); setTimeout(() => {}, 60000); }
else console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ args, stdin, sys, cwd: process.cwd(), env: process.env.DISABLE_AUTOUPDATER }) }));
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function install(kind: "ps1" | "sh") {
  const dir = mkdtempSync(join(tmpdir(), "aa-host-"));
  dirs.push(dir);
  writeFileSync(join(dir, "fake.cjs"), FAKE);
  if (kind === "ps1") {
    copyFileSync(join(SRC, "host.ps1"), join(dir, "host.ps1"));
    writeFileSync(join(dir, "fake.cmd"), `@node "%~dp0fake.cjs" %*`);
    writeFileSync(join(dir, "claude-path.txt"), join(dir, "fake.cmd"));
  } else {
    copyFileSync(join(SRC, "host.sh"), join(dir, "host.sh"));
    writeFileSync(join(dir, "fake"), `#!/bin/sh\nexec node "$(dirname "$0")/fake.cjs" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(dir, "claude-path"), join(dir, "fake").replace(/\\/g, "/"));
  }
  return dir;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const frame = (v: unknown) => {
  const body = Buffer.from(JSON.stringify(v));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};

function start(kind: "ps1" | "sh", dir: string, env: Record<string, string> = {}) {
  const p =
    kind === "ps1"
      ? spawn(
          "powershell",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "host.ps1")],
          {
            env: { ...process.env, ...env },
          },
        )
      : spawn("sh", [join(dir, "host.sh")], { env: { ...process.env, ...env } });
  let buf = Buffer.alloc(0);
  // Like Chrome: read one framed message, then disconnect (close stdin).
  const reply = new Promise<{ code: number; out: string; err: string }>((res, rej) => {
    p.stdout.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
      expect(buf.length).toBe(4 + buf.readUInt32LE(0));
      p.stdin.end();
      const m = JSON.parse(buf.subarray(4).toString("ascii"));
      res({
        code: m.code,
        out: Buffer.from(m.out, "base64").toString("utf8"),
        err: Buffer.from(m.err, "base64").toString("utf8"),
      });
    });
    p.on("close", () => rej(new Error("no reply")));
  });
  return { p, reply };
}

async function ask(kind: "ps1" | "sh", req: unknown[]) {
  const dir = install(kind);
  const { p, reply } = start(kind, dir);
  p.stdin.write(frame(req));
  const r = await reply;
  return { ...r, dir };
}

it("host.ps1 is ASCII (PowerShell 5.1 reads a BOM-less script in the ANSI code page)", () => {
  expect([...readFileSync(join(SRC, "host.ps1"), "utf8")].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
});

const kinds = [...(win ? (["ps1"] as const) : []), ...(hasSh ? (["sh"] as const) : [])];

describe.each(kinds)("Claude bridge host (%s)", (kind) => {
  it("runs claude with the fixed safe flags, the system prompt file, UTF-8 stdin and the model/effort", async () => {
    const r = await ask(kind, [b64('Système "quoted" & <x> $HOME'), b64("José Müller 😀 ünïcode"), "haiku", "low"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(JSON.parse(r.out.trim()).result);
    expect(out.stdin).toBe("José Müller 😀 ünïcode");
    expect(out.sys).toBe('Système "quoted" & <x> $HOME');
    expect(out.args.slice(0, 13)).toEqual([
      "-p",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(out.args.slice(14)).toEqual(["--model=haiku", "--effort=low"]);
    expect(out.env).toBe("1");
    expect(resolve(out.cwd).toLowerCase()).toBe(resolve(r.dir).toLowerCase());
  }, 30000);

  it("leaves model and effort out when empty", async () => {
    const r = await ask(kind, [b64("s"), b64("p"), "", ""]);
    const out = JSON.parse(JSON.parse(r.out.trim()).result);
    expect(out.args).toHaveLength(14);
  }, 30000);

  it("lists the models: the same safe flags and a fixed initialize request, nothing of the request's", async () => {
    const r = await ask(kind, [b64("s"), b64("p"), "?models", "--tools=Bash"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out.trim()).response.response;
    expect(out.args).toEqual([
      "-p",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
    ]);
    expect(JSON.parse(out.stdin)).toEqual({
      type: "control_request",
      request_id: "models",
      request: { subtype: "initialize" },
    });
  }, 30000);

  it("refuses anything but a plain model or effort name", async () => {
    for (const bad of ["--tools=Bash", "haiku --tools Bash", "Haiku", "haiku\n", "?Models"]) {
      const r = await ask(kind, [b64("s"), b64("p"), bad, ""]);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
    }
  }, 60000);

  it("reports 127 when claude can't be started", async () => {
    const dir = install(kind);
    writeFileSync(join(dir, kind === "ps1" ? "claude-path.txt" : "claude-path"), join(dir, "missing.exe"));
    const { p, reply } = start(kind, dir);
    p.stdin.write(frame([b64("s"), b64("p"), "", ""]));
    expect((await reply).code).toBe(127);
  }, 30000);

  it("stops claude when Chrome closes stdin", async () => {
    const dir = install(kind);
    const pidfile = join(dir, "pid");
    const { p, reply } = start(kind, dir, { PIDFILE: pidfile });
    reply.catch(() => undefined); // stopped: no reply comes
    p.stdin.write(frame([b64("s"), b64("SLEEP"), "", ""]));
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        pid = Number(readFileSync(pidfile, "utf8"));
      } catch {
        // not started yet
      }
    }
    expect(pid).toBeGreaterThan(0);
    p.stdin.end();
    await new Promise((r) => p.on("close", r));
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30000);
});
