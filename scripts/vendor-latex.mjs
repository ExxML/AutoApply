// Vendors the LaTeX engine for AI résumé tailoring into public/latex and public/texlive (run once; output is
// committed). MV3 forbids remote code and we fetch nothing at run time, so the engine and every TeX file it may read
// ship with the extension.
//
//   node scripts/vendor-latex.mjs [workDir]
//
// Engine: SwiftLaTeX's pdfTeX 1.40.21 build (WASM). TeX files: TeX Live 2021 from Ubuntu jammy's packages (the TeX
// Live of the engine's era), cut down to a fixed set covering the common pdfLaTeX résumé templates. The LaTeX format
// is built with the engine itself, then every fixture in test/fixtures/latex is compiled against the bundle alone.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const WORK = process.argv[2] ?? join(ROOT, "node_modules/.cache/vendor-latex");
const ENGINE_OUT = join(ROOT, "public/latex");
const TEX_OUT = join(ROOT, "public/texlive");

const ENGINE_ZIP = "https://github.com/SwiftLaTeX/SwiftLaTeX/releases/download/v20022022/20-02-2022.zip";
const UBUNTU = "http://archive.ubuntu.com/ubuntu/pool/universe";
const DEBS = [
  "t/texlive-base/texlive-base_2021.20220204-1_all.deb",
  "t/texlive-base/texlive-latex-base_2021.20220204-1_all.deb",
  "t/texlive-base/texlive-latex-recommended_2021.20220204-1_all.deb",
  "t/texlive-base/texlive-fonts-recommended_2021.20220204-1_all.deb",
  "t/texlive-base/texlive-pictures_2021.20220204-1_all.deb",
  "t/texlive-extra/texlive-latex-extra_2021.20220204-1_all.deb",
  "t/texlive-extra/texlive-plain-generic_2021.20220204-1_all.deb",
  "t/texlive-extra/texlive-fonts-extra_2021.20220204-1_all.deb",
  "t/texlive-lang/texlive-lang-english_2021.20220204-1_all.deb",
  "l/lmodern/lmodern_2.004.5-6.1_all.deb",
  "c/cm-super/cm-super-minimal_0.3.4-17_all.deb",
];

// Macro packages, by their directory under tex/ (a trailing "/**" takes subdirectories too).
const TEX_DIRS = [
  // kernel and its support
  "latex/base",
  "latex/l3kernel",
  "latex/l3backend",
  "latex/l3packages/**",
  "latex/latexconfig",
  "latex/graphics",
  "latex/graphics-cfg",
  "latex/graphics-def",
  "latex/tools",
  "latex/amsmath",
  "latex/amsfonts",
  "latex/amscls",
  "latex/psnfss",
  "latex/lm",
  "latex/cm-super",
  // what résumé templates load
  "latex/geometry",
  "latex/titlesec",
  "latex/enumitem",
  "latex/hyperref",
  "latex/url",
  "latex/xcolor",
  "latex/colortbl",
  "latex/fontawesome5",
  "latex/fancyhdr",
  "latex/preprint",
  "latex/marvosym",
  "latex/moderncv",
  "latex/microtype",
  "latex/ragged2e",
  "latex/setspace",
  "latex/parskip",
  "latex/multirow",
  "latex/arydshln",
  "latex/changepage",
  "latex/booktabs",
  "latex/float",
  "latex/wrapfig",
  "latex/sectsty",
  "latex/soul",
  "latex/comment",
  "latex/xifthen",
  "latex/ifmtarg",
  "latex/xstring",
  "latex/textpos",
  "latex/lastpage",
  "latex/bookmark",
  "latex/paracol",
  "latex/eso-pic",
  "latex/everyshi",
  "latex/fontaxes",
  "latex/mweights",
  "latex/etoolbox",
  "latex/kvoptions",
  "latex/atveryend",
  "latex/auxhook",
  "latex/rerunfilecheck",
  "latex/refcount",
  "latex/letltxmacro",
  "latex/hycolor",
  "latex/xkeyval",
  "latex/etexcmds",
  "latex/epstopdf-pkg",
  "latex/grfext",
  "latex/kvsetkeys",
  "latex/ltxcmds",
  "latex/pdftexcmds",
  "latex/stringenc",
  "latex/hopatch",
  "latex/hyphenat",
  "latex/fontenc",
  // generic
  "generic/babel",
  "generic/babel-english",
  "generic/iftex",
  "generic/infwarerr",
  "generic/ltxcmds",
  "generic/kvsetkeys",
  "generic/kvdefinekeys",
  "generic/pdftexcmds",
  "generic/pdfescape",
  "generic/bigintcalc",
  "generic/bitset",
  "generic/intcalc",
  "generic/etexcmds",
  "generic/gettitlestring",
  "generic/uniquecounter",
  "generic/atbegshi",
  "generic/atveryend",
  "generic/pdftex",
  "generic/xkeyval",
  "generic/stringenc",
  "generic/xstring",
  "generic/ulem",
  "generic/soul",
  // TikZ: moderncv draws with it, and so do icon-heavy templates.
  "generic/pgf/**",
  "latex/pgf/**",
];
// Read only while building the format (it preloads them), or by other engines.
const NOT_AT_RUN_TIME = /\.(lua|pfm|afm|dtx|ins|ini)$|^(latex\.ltx|expl3-code\.tex)$/;

// Fonts: [directory under fonts/, file filter]. Computer Modern, Latin Modern, the EC/TC metrics (drawn with
// cm-super's 10 pt outlines), Times/Helvetica/Courier (URW), Charter, Font Awesome 5 and marvosym.
const ALL = () => true;
// Latin Modern in the OT1, T1 and TS1 encodings and math; not its many other encodings.
const LM_TFM = (f) => /^(rm-|ec-|ts1-|lmmi|lmsy|lmex|lmbsy|lmmib)/.test(f);
const LM_PFB = (f) =>
  !/^lm(vt|tl|tk|tcs|ssdc|ssdo|ssq|dun|u10|b10|bo10|bxo|csco|tto|ro(8|9|17)|sso(8|9|12|17))/.test(f);
const PS_FONTS = /^(p|u)(tm|hv|cr|sy|zd)/;
const FONT_DIRS = [
  ["tfm/public/cm", ALL],
  ["tfm/public/amsfonts/**", ALL],
  ["tfm/public/latex-fonts", ALL],
  ["tfm/jknappen/ec", ALL],
  ["type1/public/amsfonts/cm", ALL],
  ["type1/public/amsfonts/cmextra", ALL],
  ["type1/public/amsfonts/symbols", ALL],
  ["type1/public/amsfonts/latxfont", ALL],
  ["tfm/public/lm", LM_TFM],
  ["type1/public/lm", LM_PFB],
  ["enc/dvips/lm", ALL],
  // The common shapes: roman, bold, italic, slanted, caps, typewriter and sans.
  ["type1/public/cm-super", (f) => /^sf(rm|bx|ti|it|sl|cc|xc|tt|ss|sx|si|so|bi)1000\.pfb$/.test(f)],
  ["enc/dvips/cm-super", ALL],
  ["tfm/public/fontawesome5", ALL],
  ["type1/public/fontawesome5", ALL],
  ["enc/dvips/fontawesome5", ALL],
  ["tfm/public/marvosym", ALL],
  ["type1/public/marvosym", ALL],
  ["tfm/adobe/times", ALL],
  ["tfm/adobe/helvetic", ALL],
  ["tfm/adobe/courier", ALL],
  ["tfm/adobe/symbol", ALL],
  ["tfm/adobe/zapfding", ALL],
  ["vf/adobe/times", ALL],
  ["vf/adobe/helvetic", ALL],
  ["vf/adobe/courier", ALL],
  ["type1/urw/times", ALL],
  ["type1/urw/helvetic", ALL],
  ["type1/urw/courier", ALL],
  ["type1/urw/symbol", ALL],
  ["type1/urw/zapfding", ALL],
  ["enc/dvips/base", ALL],
  ["tfm/bitstrea/charter", ALL],
  ["vf/bitstrea/charter", ALL],
  ["type1/bitstrea/charter", ALL],
];
const MAPS = [
  "amsfonts/cm.map",
  "amsfonts/cmextra.map",
  "amsfonts/symbols.map",
  "amsfonts/latxfont.map",
  "lm/lm.map",
  "cm-super/cm-super-minimal-t1.map",
  "cm-super/cm-super-minimal-ts1.map",
  "fontawesome5/fontawesome5.map",
  "marvosym/marvosym.map",
  "psnfss/charter.map",
];

// kpathsea format ids the engine asks with: pdftex/<id>/<name>.
const FORMAT = { ".tfm": 3, ".fmt": 10, ".map": 11, ".pfb": 32, ".vf": 33, ".enc": 44 };
const formatOf = (name) => FORMAT[extname(name)] ?? 26;

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const kb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function download() {
  mkdirSync(join(WORK, "debs"), { recursive: true });
  const zip = join(WORK, "engine.zip");
  if (!existsSync(zip)) sh("curl", ["-sSfL", "-o", zip, ENGINE_ZIP]);
  const tree = join(WORK, "root");
  for (const d of DEBS) {
    const file = join(WORK, "debs", basename(d));
    if (!existsSync(file)) sh("curl", ["-sSf", "-o", file, `${UBUNTU}/${d}`]);
  }
  if (!existsSync(join(tree, ".done"))) {
    for (const d of DEBS) sh("dpkg-deb", ["-x", join(WORK, "debs", basename(d)), tree]);
    writeFileSync(join(tree, ".done"), "");
  }
  return { zip, tree };
}

/** Every file of the TeX trees by name; TeX Live's own tree wins over the distribution's extras. */
function indexTree(tree) {
  const index = new Map();
  const trees = ["usr/share/texlive/texmf-dist", "usr/share/texmf"].map((t) => join(tree, t));
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!/^(doc|source)$/.test(e.name)) walk(p);
      } else if (e.isFile() && !index.has(e.name)) index.set(e.name, p);
    }
  };
  trees.forEach(walk);
  return { index, trees };
}

function filesIn(trees, sub, filter = ALL) {
  const deep = sub.endsWith("/**");
  const rel = deep ? sub.slice(0, -3) : sub;
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (deep && !/^(doc|source)$/.test(e.name)) walk(p);
      } else if (e.isFile() && filter(e.name)) out.push(p);
    }
  };
  for (const t of trees) walk(join(t, rel));
  return out;
}

/**
 * EC/TC metrics at sizes cm-super-minimal has no outlines for (10.95 pt and the like) are drawn with its 10 pt
 * outline of the same shape. Glyphs keep their TFM widths, so the layout is exact; the strokes are 10 pt's.
 */
function ecFallbackMap(trees, mapped, bundle) {
  const lines = [];
  const pfbs = new Set(filesIn(trees, "fonts/type1/public/cm-super").map((p) => basename(p, ".pfb")));
  for (const tfm of filesIn(trees, "fonts/tfm/jknappen/ec")) {
    const name = basename(tfm, ".tfm");
    const m = /^(ec|tc)([a-z]+)(\d{4})$/.exec(name);
    if (!m || mapped.has(name)) continue;
    const sf = `sf${m[2]}1000`;
    if (!pfbs.has(sf) || !bundle.has(`${sf}.pfb`)) continue;
    const enc =
      m[1] === "ec" ? '"T1Encoding ReEncodeFont" <cm-super-t1.enc' : '"TS1Encoding ReEncodeFont" <cm-super-ts1.enc';
    lines.push(`${name} ${sf.toUpperCase()} ${enc} <${sf}.pfb`);
  }
  return lines;
}

/** One map for every bundled font; a line whose outline isn't bundled would stop pdfTeX, so it is left out. */
function pdftexMap(trees, bundle) {
  const read = (rel) => {
    for (const t of trees)
      if (existsSync(join(t, "fonts/map/dvips", rel))) return readFileSync(join(t, "fonts/map/dvips", rel), "utf8");
    throw new Error(`missing map ${rel}`);
  };
  const lines = MAPS.flatMap((m) => read(m).split("\n")).filter((l) => l.trim() && !/^[%#]/.test(l));
  // The base PostScript fonts: Times, Helvetica, Courier, Symbol and Dingbats only.
  lines.push(
    ...read("tetex/pdftex35.map")
      .split("\n")
      .filter((l) => PS_FONTS.test(l)),
  );
  const mapped = new Set(lines.map((l) => l.split(/\s+/)[0]));
  const bundled = (l) => [...l.matchAll(/<<?\[?([\w.-]+\.pf[ab])/g)].every((m) => bundle.has(m[1]));
  return [...lines, ...ecFallbackMap(trees, mapped, bundle)].filter(bundled).join("\n") + "\n";
}

const LANGUAGE_DAT = `% English only: résumés are hyphenated as US or UK English.
english\t\thyphen.tex
=usenglish
=USenglish
=american
ukenglish\tloadhyph-en-gb.tex
=british
=UKenglish
dumylang\tdumyhyph.tex
nohyphenation\tzerohyph.tex
`;
const LANGUAGE_DEF = `%% e-TeX V2.0;2
\\addlanguage {USenglish}{hyphen}{}{2}{3} %%% This MUST be the first non-comment line of the file
\\addlanguage {ukenglish}{loadhyph-en-gb.tex}{}{2}{3}
\\addlanguage {dumylang}{dumyhyph.tex}{}{2}{3}
\\addlanguage {nohyphenation}{zerohyph.tex}{}{2}{3}
`;

/** The engine in Chromium, reading TeX files by name from `files` (served under http://tex.test/texlive/). */
async function engine(files) {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage();
  const requests = [];
  await page.route("http://tex.test/**", (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const m = /^\/texlive\/pdftex\/\d+\/(.+)$/.exec(path);
    if (m) {
      const file = files.get(m[1]);
      requests.push([path, !!file]);
      return file
        ? route.fulfill({ body: readFileSync(file), contentType: "application/octet-stream" })
        : route.fulfill({ status: 404, body: "" });
    }
    if (path === "/texlive/files.txt")
      return route.fulfill({
        body: [...files.keys()].map((n) => `${formatOf(n)}/${n}`).join("\n"),
        contentType: "text/plain",
      });
    const f = join(ENGINE_OUT, path.replace(/^\/latex\//, "/"));
    if (!path.startsWith("/latex/") || !existsSync(f))
      return route.fulfill({ body: "<!doctype html><title>tex</title>", contentType: "text/html" });
    return route.fulfill({
      body: readFileSync(f),
      contentType: f.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    });
  });
  await page.goto("http://tex.test/");
  const run = (src, format) =>
    page.evaluate(
      async ({ src, format }) => {
        const t0 = performance.now();
        const w = new Worker("latex/worker.js");
        await new Promise((ok, fail) => (w.onmessage = (e) => (e.data.result === "ok" ? ok() : fail(e.data))));
        w.postMessage({ cmd: "settexliveurl", url: `${location.origin}/texlive/` });
        const compile = () =>
          new Promise((ok) => {
            w.onmessage = (e) => e.data.cmd === "compile" && ok(e.data);
            w.postMessage({ cmd: "writefile", url: "main.tex", src });
            w.postMessage({ cmd: "setmainfile", url: "main.tex" });
            w.postMessage({ cmd: format ? "compileformat" : "compilelatex" });
          });
        const r = await compile();
        const cold = performance.now() - t0;
        const t1 = performance.now();
        if (!format) await compile();
        const warm = performance.now() - t1;
        w.terminate();
        let b64 = "";
        if (r.pdf) {
          const u = new Uint8Array(r.pdf);
          for (let i = 0; i < u.length; i += 0x8000) b64 += String.fromCharCode(...u.subarray(i, i + 0x8000));
        }
        return { status: r.status, log: r.log, out: r.pdf ? btoa(b64) : "", cold, warm };
      },
      { src, format },
    );
  return { run, requests, close: () => browser.close() };
}

async function main() {
  const { zip, tree } = download();
  const { index, trees } = indexTree(tree);

  // Engine: the vendored worker script and its WASM, unchanged. worker.js (committed) wraps them.
  mkdirSync(ENGINE_OUT, { recursive: true });
  for (const f of ["swiftlatexpdftex.js", "swiftlatexpdftex.wasm"])
    sh("unzip", ["-o", "-j", "-q", zip, f, "-d", ENGINE_OUT]);

  // The bundle, by file name (kpathsea's lookups are by name).
  const bundle = new Map();
  const add = (p) => bundle.has(basename(p)) || bundle.set(basename(p), p);
  for (const d of TEX_DIRS) filesIn(trees, `tex/${d}`, (f) => !NOT_AT_RUN_TIME.test(f)).forEach(add);
  for (const [d, filter] of FONT_DIRS) filesIn(trees, `fonts/${d}`, filter).forEach(add);
  const gen = join(WORK, "generated");
  mkdirSync(gen, { recursive: true });
  writeFileSync(join(gen, "pdftex.map"), pdftexMap(trees, bundle));
  writeFileSync(join(gen, "language.dat"), LANGUAGE_DAT);
  writeFileSync(join(gen, "language.def"), LANGUAGE_DEF);
  for (const f of readdirSync(gen)) bundle.set(f, join(gen, f));

  // The format, built from the whole tree (hyphenation patterns are only read here).
  const all = new Map([...index, ...bundle]);
  let e = await engine(all);
  const fmt = await e.run("", true);
  await e.close();
  if (fmt.status !== 0 || !fmt.out) throw new Error(`format build failed:\n${fmt.log.slice(-2000)}`);
  writeFileSync(join(gen, "swiftlatexpdftex.fmt"), Buffer.from(fmt.out, "base64"));
  bundle.set("swiftlatexpdftex.fmt", join(gen, "swiftlatexpdftex.fmt"));

  // Lay it out the way the engine asks for files.
  rmSync(TEX_OUT, { recursive: true, force: true });
  let size = 0;
  for (const [name, p] of bundle) {
    const dir = join(TEX_OUT, "pdftex", String(formatOf(name)));
    mkdirSync(dir, { recursive: true });
    cpSync(p, join(dir, name));
    size += statSync(p).size;
  }
  // What an upload's \usepackage / \documentclass may name.
  const names = (ext) =>
    [...bundle.keys()]
      .filter((n) => n.endsWith(ext))
      .map((n) => n.slice(0, -ext.length))
      .sort();
  // The worker's list of what exists, so a lookup of anything else costs no request.
  const listed = [...bundle.keys()].map((n) => `${formatOf(n)}/${n}`).sort();
  writeFileSync(join(TEX_OUT, "files.txt"), listed.join("\n") + "\n");
  writeFileSync(
    join(TEX_OUT, "packages.json"),
    JSON.stringify({ packages: names(".sty"), classes: names(".cls") }) + "\n",
  );

  // Every fixture compiles from the bundle alone.
  const fixtures = join(ROOT, "test/fixtures/latex");
  e = await engine(bundle);
  let failed = 0;
  for (const f of readdirSync(fixtures).filter((n) => n.endsWith(".tex"))) {
    e.requests.length = 0;
    const r = await e.run(readFileSync(join(fixtures, f), "utf8"), false);
    const missing = [
      ...new Set(
        e.requests
          .filter(([p, ok]) => !ok && index.has(basename(p)) && !/\.(aux|out|vf)$/.test(p))
          .map(([p]) => basename(p)),
      ),
    ];
    const ok = r.status === 0 && r.out;
    if (!ok) failed++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${f}: cold ${Math.round(r.cold)} ms, warm ${Math.round(r.warm)} ms${missing.length ? `; in TeX Live but not bundled: ${missing.join(" ")}` : ""}`,
    );
    if (!ok)
      console.log(
        r.log
          .split("\n")
          .filter((l) => /^!|^l\.\d/.test(l))
          .slice(0, 6)
          .join("\n"),
      );
  }
  await e.close();
  const wasm =
    statSync(join(ENGINE_OUT, "swiftlatexpdftex.wasm")).size + statSync(join(ENGINE_OUT, "swiftlatexpdftex.js")).size;
  console.log(`engine ${kb(wasm)}, TeX files ${kb(size)} (${bundle.size} files)`);
  if (failed) process.exit(1);
}

await main();
