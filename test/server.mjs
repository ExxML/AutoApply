// Static server for test/fixtures on two ports (the second makes iframes cross-origin).
// Paths under /jobs/ map to the fixtures folder so URLs look like job pages.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "fixtures");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".pdf": "application/pdf",
};
export const PORTS = [5501, 5502];

const handler = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rel = normalize(decodeURIComponent(url.pathname).replace(/^\/(jobs\/)?/, ""));
  if (rel.startsWith("..")) return void res.writeHead(403).end();
  try {
    const body = await readFile(join(ROOT, rel || "plain.html"));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
};

for (const port of PORTS)
  createServer(handler).listen(port, () => console.log(`fixtures on http://localhost:${port}/jobs/`));
