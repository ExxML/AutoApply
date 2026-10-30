// The bundled pdfLaTeX (public/latex, vendored by scripts/vendor-latex.mjs), for extension pages: the options page
// checks an upload with it, and the offscreen document compiles tailored résumés. Each compile starts a worker and
// ends it, so nothing stays in memory between compiles.
import { toBase64 } from "../shared/base64";
import { pageCount } from "../shared/latex";

export interface CompileResult {
  /** Base64 of the PDF; "" when the compile failed. */
  pdf: string;
  log: string;
  pages: number;
}

export function compileTex(src: string, timeoutMs = 30_000): Promise<CompileResult> {
  const worker = new Worker(chrome.runtime.getURL("latex/worker.js"));
  return new Promise<CompileResult>((resolve) => {
    const done = (r: CompileResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done({ pdf: "", log: "! The LaTeX compile timed out.", pages: 0 }), timeoutMs);
    worker.onerror = (e) => done({ pdf: "", log: `! The LaTeX engine failed to start: ${e.message}`, pages: 0 });
    worker.onmessage = (e: MessageEvent<{ result: string }>) => {
      if (e.data.result !== "ok") return done({ pdf: "", log: "! The LaTeX engine failed to start.", pages: 0 });
      worker.onmessage = (m: MessageEvent<{ cmd?: string; status: number; log: string; pdf?: ArrayBuffer }>) => {
        if (m.data.cmd !== "compile") return;
        const ok = m.data.status === 0 && !!m.data.pdf;
        done({
          pdf: ok ? toBase64(m.data.pdf!) : "",
          log: m.data.log ?? "",
          pages: ok ? pageCount(m.data.log) || 1 : 0,
        });
      };
      worker.postMessage({ cmd: "settexliveurl", url: chrome.runtime.getURL("texlive/") });
      worker.postMessage({ cmd: "writefile", url: "main.tex", src });
      worker.postMessage({ cmd: "setmainfile", url: "main.tex" });
      worker.postMessage({ cmd: "compilelatex" });
    };
  });
}
