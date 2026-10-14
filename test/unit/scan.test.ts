import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBody, stubLayout } from "./dom";
import { newScanState, scan, type FieldHandle } from "../../src/content/scan/fields";
import { detect } from "../../src/content/detect";

beforeAll(stubLayout);
beforeEach(() => setBody(""));

const fields = (): FieldHandle[] => scan(newScanState()).handles;
const loc = (href: string) => new URL(href) as unknown as Location;

describe("label extraction (§11.5)", () => {
  it("uses <label for=>", () => {
    setBody(`<form><label for="fn">First name *</label><input id="fn" required></form>`);
    const [h] = fields();
    expect(h.desc).toMatchObject({ label: "First name", required: true, kind: "text" });
  });

  it("uses a wrapping <label>, excluding option text", () => {
    setBody(`<label>Country <select><option value="">Select…</option><option>Canada</option></select></label>`);
    const [h] = fields();
    expect(h.desc.label).toBe("Country");
    expect(h.desc.options).toEqual(["Canada"]);
  });

  it("prefers aria-labelledby", () => {
    setBody(
      `<span id="q">Why do you want this job?</span><label for="t">ignored</label><textarea id="t" aria-labelledby="q"></textarea>`,
    );
    expect(fields()[0].desc).toMatchObject({ label: "Why do you want this job?", kind: "textarea" });
  });

  it("uses the fieldset legend for radio groups and member labels as options", () => {
    setBody(`<fieldset><legend>Willing to relocate?</legend>
      <label><input type="radio" name="rel" value="y"> I am willing to relocate</label>
      <label><input type="radio" name="rel" value="n"> I am not willing to relocate</label></fieldset>`);
    const [h] = fields();
    expect(h.desc).toMatchObject({
      kind: "radio_group",
      label: "Willing to relocate?",
      options: ["I am willing to relocate", "I am not willing to relocate"],
    });
  });

  it("falls back to container text preceding the control", () => {
    setBody(`<div class="row"><div class="q">Expected graduation</div><div><input name="x1"></div></div>
             <div class="row"><div class="q">GPA</div><div><input name="x2"></div></div>`);
    const hs = fields();
    expect(hs.map((h) => h.desc.label)).toEqual(["Expected graduation", "GPA"]);
  });

  it("falls back to placeholder, then humanized name", () => {
    setBody(`<div><input placeholder="Your city"></div><div><input name="preferredStartDate"></div>`);
    expect(fields().map((h) => h.desc.label)).toEqual(["Your city", "preferred start date"]);
  });

  it("descends into open shadow roots and resolves labels there", () => {
    setBody(`<x-form></x-form>`);
    const host = document.querySelector("x-form")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<label for="e">Email address</label><input id="e" type="email">`;
    const [h] = fields();
    expect(h.desc).toMatchObject({ label: "Email address", kind: "email" });
  });

  it("reads hints from aria-describedby and helper classes", () => {
    setBody(`<div><label for="a">Portfolio</label><input id="a" aria-describedby="h"><span id="h">Link to your work</span></div>
      <div><label for="b">Bio</label><textarea id="b"></textarea><p class="help-text">Max 100 words</p></div>`);
    const hs = fields();
    expect(hs[0].desc.hint).toBe("Link to your work");
    expect(hs[1].desc.hint).toBe("Max 100 words");
  });
});

describe("grouping (§11.5)", () => {
  it("groups radios by name", () => {
    setBody(`<div><p>Gender</p><input type="radio" name="g" id="a"><label for="a">Woman</label>
      <input type="radio" name="g" id="b"><label for="b">Man</label></div>
      <div><p>Veteran?</p><input type="radio" name="v" id="c"><label for="c">Yes</label>
      <input type="radio" name="v" id="d"><label for="d">No</label></div>`);
    const hs = fields();
    expect(hs.map((h) => [h.desc.kind, h.desc.options])).toEqual([
      ["radio_group", ["Woman", "Man"]],
      ["radio_group", ["Yes", "No"]],
    ]);
  });

  it("detects button-style Yes/No groups (aria-pressed and plain buttons under a question)", () => {
    setBody(`<div><p>Are you 18 or older?</p><div><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button></div></div>
      <div><p>Do you have a driver's license?</p><div><button type="button">Yes</button><button type="button">No</button></div></div>
      <div><p>Actions</p><div><button type="button">Back</button><button type="button">Next</button></div></div>
      <div role="radiogroup" aria-label="Work arrangement"><div role="radio" aria-checked="false">Remote</div><div role="radio" aria-checked="false">Hybrid</div></div>`);
    const hs = fields();
    expect(hs.map((h) => [h.desc.kind, h.desc.label, h.desc.options])).toEqual([
      ["radio_group", "Are you 18 or older?", ["Yes", "No"]],
      ["radio_group", "Do you have a driver's license?", ["Yes", "No"]],
      ["radio_group", "Work arrangement", ["Remote", "Hybrid"]],
    ]);
  });

  it("lone checkbox vs checkbox group", () => {
    setBody(`<label><input type="checkbox" name="terms"> I agree to the terms</label>
      <fieldset><legend>Skills</legend><label><input type="checkbox" name="s"> Python</label><label><input type="checkbox" name="s"> Go</label></fieldset>`);
    const hs = fields();
    expect(hs[0].desc).toMatchObject({ kind: "checkbox", label: "I agree to the terms" });
    expect(hs[0].consent).toBe(true);
    expect(hs[1].desc).toMatchObject({
      kind: "checkbox_group",
      label: "Skills",
      options: ["Python", "Go"],
      multiple: true,
    });
  });
});

describe("widget classification (Appendix C.3)", () => {
  const triggers = [
    `<div role="combobox" aria-expanded="false">Select…</div>`,
    `<button aria-haspopup="listbox">Choose</button>`,
    `<div class="react-select__control"><input readonly></div>`,
    `<div class="Select-control">Pick</div>`,
    `<div class="MuiSelect-select">Pick</div>`,
    `<div class="MuiAutocomplete-root"><input></div>`,
    `<div class="ant-select-selector">Pick</div>`,
    `<div class="choices__inner">Pick</div>`,
    `<span class="select2-selection">Pick</span>`,
    `<div class="vs__dropdown-toggle">Pick</div>`,
    `<button class="btn dropdown-toggle">Pick</button>`,
    `<div data-automation-id="selectWidget">Pick</div>`,
    `<div data-testid="country-select">Pick</div>`,
  ];
  it.each(triggers)("%s → dropdown", (html) => {
    setBody(`<div><label>Country</label>${html}</div>`);
    const hs = fields();
    expect(hs).toHaveLength(1);
    expect(hs[0].desc.kind).toBe("dropdown");
    expect(hs[0].desc.optionsKnown).toBe(false);
  });

  it("question button with aria-expanded/aria-controls → dropdown", () => {
    setBody(
      `<div><p>Which term are you available?</p><button type="button" aria-expanded="false" aria-controls="m">Pick</button></div>`,
    );
    expect(fields()[0].desc.kind).toBe("dropdown");
  });

  it("harvests options from a hidden native select backing a widget", () => {
    setBody(`<div><label>Province</label><div class="select__control">Select…</div>
      <select style="display:none"><option value="">Select</option><option>Alberta</option><option>British Columbia</option></select></div>`);
    const [h] = fields();
    expect(h.desc).toMatchObject({ kind: "dropdown", optionsKnown: true, options: ["Alberta", "British Columbia"] });
    expect(h.hiddenSelect).toBeTruthy();
  });

  it("typeaheads: combobox inputs, aria-autocomplete, and location inputs with aria-controls", () => {
    setBody(`<div><label for="a">School</label><input id="a" role="combobox"></div>
      <div><label for="b">Skills</label><input id="b" aria-autocomplete="list"></div>
      <div><label for="c">Location</label><input id="c" aria-controls="sugg"></div>
      <div><label for="d">Nickname</label><input id="d" aria-controls="x"></div>`);
    expect(fields().map((h) => h.desc.kind)).toEqual(["typeahead", "typeahead", "typeahead", "text"]);
  });

  it("native multiple select → multiselect", () => {
    setBody(`<label>Langs <select multiple><option>EN</option><option>FR</option></select></label>`);
    expect(fields()[0].desc.kind).toBe("multiselect");
  });
});

describe("skipping and visibility (§11.3, §11.6)", () => {
  it("skips hidden, disabled, readonly, password, search, captcha, nav and cookie-banner fields", () => {
    setBody(`<nav><input placeholder="Search jobs"></nav>
      <div id="onetrust-banner"><label><input type="checkbox"> Accept cookies</label></div>
      <form><label>A <input name="a"></label><label>B <input name="b" disabled></label>
      <label>C <input name="c" readonly></label><label>D <input name="d" type="password"></label>
      <label>E <input name="e" style="display:none"></label><label>Captcha <input name="captcha"></label>
      <label>Résumé <input type="file" style="display:none"></label></form>`);
    expect(fields().map((h) => h.desc.label)).toEqual(["A", "Résumé"]);
  });

  it("reports prefilled fields and keeps stable ids across rescans", () => {
    setBody(`<label>Name <input value="Ada"></label><label>Email <input></label>`);
    const state = newScanState();
    const a = scan(state).handles;
    expect(a.map((h) => h.prefilled)).toEqual([true, false]);
    expect(scan(state).handles.map((h) => h.id)).toEqual(a.map((h) => h.id));
  });

  it("flags payment and government-id fields as sensitive", () => {
    setBody(
      `<label>Card number <input autocomplete="cc-number"></label><label>Social Insurance Number <input></label>`,
    );
    expect(fields().map((h) => h.sensitive)).toEqual([true, true]);
  });
});

describe("detection scoring (§11.2)", () => {
  it("scores an application form above the threshold", () => {
    document.title = "Apply – Software Intern";
    setBody(`<h1>Software Engineering Intern</h1><form>
      <label>First name <input></label><label>Last name <input></label><label>Email <input type="email"></label>
      <label>Phone <input type="tel"></label><label>LinkedIn <input></label><label>City <input></label>
      <label>Resume <input type="file"></label><button>Submit application</button></form>`);
    const d = detect(fields(), loc("https://boards.greenhouse.io/acme/jobs/123"));
    expect(d.score).toBe(100);
  });

  it("scores a login page below the maybe threshold", () => {
    document.title = "Sign in";
    setBody(
      `<form><label>Email <input type="email"></label><label>Password <input type="password"></label><button>Sign in</button></form>`,
    );
    expect(detect(fields(), loc("https://example.com/login")).score).toBeLessThan(30);
  });

  it("penalizes a lone search box", () => {
    document.title = "Jobs";
    setBody(`<form role="search"><input type="search"></form>`);
    expect(detect(fields(), loc("https://example.com/jobs")).score).toBeLessThan(30);
  });
});

describe("detection on fixture pages (§11.2)", async () => {
  const { readFileSync } = await import("node:fs");
  const load = (file: string) => {
    const doc = new DOMParser().parseFromString(readFileSync(`test/fixtures/${file}`, "utf8"), "text/html");
    document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML; // scripts do not run: static markup only
    return detect(fields(), loc(`http://localhost:5501/jobs/${file}`)).score;
  };
  it.each([
    "plain.html",
    "custom-dropdown.html",
    "typeahead.html",
    "buttons-group.html",
    "semantic.html",
    "iframe-form.html",
    "dropzone.html",
    "consent.html",
  ])("%s scores at or above the auto-fill threshold", (file) => {
    expect(load(file)).toBeGreaterThanOrEqual(50);
  });
  it("login.html scores below the maybe threshold", () => {
    expect(load("login.html")).toBeLessThan(30);
  });
});
