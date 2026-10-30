// The LaTeX worker: SwiftLaTeX's pdfTeX (swiftlatexpdftex.js, vendored unchanged by scripts/vendor-latex.mjs),
// reading TeX files from the extension's own texlive/ folder instead of a TeX Live server.
// kpathsea asks for some files without their suffix ("3/cmr10"), and static files carry no "fileid" header naming
// the cached copy, so both are supplied here. Files not in the bundle answer 404 without a request.
const SUFFIX = { 3: ".tfm", 10: ".fmt", 11: ".map", 26: ".tex", 32: ".pfb", 33: ".vf", 44: ".enc" };
const Xhr = self.XMLHttpRequest;
const list = new Xhr();
list.open("GET", "../texlive/files.txt", false);
list.send();
const bundled = new Set(list.responseText.split("\n"));
self.XMLHttpRequest = class extends Xhr {
  open(method, url, ...rest) {
    this.url = String(url).replace(/\/pdftex\/(\d+)\/([^/.]+)$/, (s, f, n) =>
      SUFFIX[f] ? `/pdftex/${f}/${n}${SUFFIX[f]}` : s,
    );
    this.missing = /\/pdftex\//.test(this.url) && !bundled.has(this.url.split("/pdftex/").pop());
    return super.open(method, this.url, ...rest);
  }
  send(...body) {
    if (!this.missing) super.send(...body);
  }
  get status() {
    return this.missing ? 404 : super.status;
  }
  getResponseHeader(h) {
    return /^(fileid|pkid)$/i.test(h) ? this.url.split("/").pop() : super.getResponseHeader(h);
  }
};
// eslint-disable-next-line no-undef -- a worker global
importScripts("swiftlatexpdftex.js");
