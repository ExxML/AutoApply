import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setBody, stubLayout } from "./dom";
import { consentPair, newScanState, scan, type FieldHandle } from "../../src/content/scan/fields";
import { deepQueryAll } from "../../src/content/scan/traverse";
import { RE_OPTIONAL_CONSENT } from "../../src/shared/constants";
import { extractJobContext } from "../../src/content/jobContextExtract";
import { findOptionsContainer, snapshot } from "../../src/content/fill/dropdown";

beforeAll(stubLayout);
beforeEach(() => setBody(""));

const fields = (): FieldHandle[] => scan(newScanState()).handles;

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

  it("ignores hidden status text inside a wrapping <label> (Lever)", () => {
    setBody(`<label><div>Current location ✱</div><div><input name="location" required>
      <div style="display:none">No location found. Try entering a different location</div></div></label>`);
    expect(fields()[0].desc.label).toBe("Current location");
  });

  it("strips Lever's ✱ required marker", () => {
    setBody(`<label><div>Full name<span>✱</span></div><input required></label>`);
    expect(fields()[0].desc).toMatchObject({ label: "Full name", required: true });
  });

  it("prefers aria-labelledby", () => {
    setBody(
      `<span id="q">Why do you want this job?</span><label for="t">ignored</label><textarea id="t" aria-labelledby="q"></textarea>`,
    );
    expect(fields()[0].desc).toMatchObject({ label: "Why do you want this job?", kind: "textarea" });
  });

  it("uses the upload group's label over a generic 'Attach' input label (Greenhouse)", () => {
    const upload = (id: string, q: string) => `<div role="group" aria-labelledby="l-${id}">
      <div id="l-${id}">${q}<span>*</span></div><div><div><div><div><button type="button">Attach</button>
      <label for="${id}">Attach</label><input id="${id}" type="file"></div></div></div></div></div>`;
    setBody(
      `<form>${upload("resume", "Resume/CV")}${upload("q1", "Please upload your unofficial transcript.")}</form>`,
    );
    expect(fields().map((h) => [h.desc.label, h.desc.required])).toEqual([
      ["Resume/CV", true],
      ["Please upload your unofficial transcript.", true],
    ]);
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

  it("asks chrome.dom for closed shadow roots once per element (Edge logs every chrome.* call)", () => {
    setBody(`<div id="host"></div><x-late></x-late><p>text</p>`);
    const host = document.getElementById("host")!;
    const closed = host.attachShadow({ mode: "closed" });
    closed.innerHTML = `<div role="listbox"></div>`;
    const probe = vi.fn((el: Element) => (el === host ? closed : null));
    vi.stubGlobal("chrome", { dom: { openOrClosedShadowRoot: probe } });
    // happy-dom never matches :defined; browsers match every element except not-yet-upgraded custom elements.
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, s: string) {
      return s === ":defined" ? !this.localName.includes("-") : matches.call(this, s);
    });
    try {
      expect(deepQueryAll("[role=listbox]")).toHaveLength(1);
      probe.mockClear();
      expect(deepQueryAll("[role=listbox]")).toHaveLength(1);
      // Only the closed host and the not-yet-defined custom element are probed again.
      expect(probe.mock.calls.map(([el]) => el.localName).sort()).toEqual(["div", "x-late"]);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
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
    // Ashby (Rivian): the question's <label>, then a note too long to keep whole.
    const note = "The information being requested will be used exclusively for export controls. ".repeat(5);
    setBody(`<div><label for="q1">Is your most recent country of citizenship one of the following: Cuba?</label>
      <div><p><em>${note}</em></p></div><div><button aria-pressed="false">Yes</button><button aria-pressed="false">No</button>
      <input type="checkbox" name="q1" hidden></div></div>`);
    expect(fields()[0].desc.label).toBe("Is your most recent country of citizenship one of the following: Cuba?");
  });

  it("native radios wrapped in role=radio divs make one question (Workable)", () => {
    const opt = (v: string) =>
      `<div role="radio" aria-checked="false"><label><input type="radio" name="q" aria-hidden="true"><span>${v}</span></label></div>`;
    setBody(
      `<span id="ql">Are you eligible to work?</span><fieldset role="radiogroup" aria-labelledby="ql">${opt("YES")}${opt("NO")}</fieldset>`,
    );
    expect(fields().map((h) => [h.desc.kind, h.desc.options])).toEqual([["radio_group", ["YES", "NO"]]]);
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

  it("groups checkboxes named after their own options (Ashby), not unrelated boxes in one fieldset", () => {
    setBody(`<fieldset><label for="q1">How did you hear about us?</label>
        <div><input type="checkbox" id="a" name="LinkedIn"><label for="a">LinkedIn</label></div>
        <div><input type="checkbox" id="b" name="Glassdoor"><label for="b">Glassdoor</label></div></fieldset>
      <fieldset><label><input type="checkbox" name="terms"> I agree to the terms</label>
        <label><input type="checkbox" name="news"> Send me news</label></fieldset>`);
    expect(fields().map((h) => [h.desc.kind, h.desc.label, h.desc.options])).toEqual([
      ["checkbox_group", "How did you hear about us?", ["LinkedIn", "Glassdoor"]],
      ["checkbox", "I agree to the terms", undefined],
      ["checkbox", "Send me news", undefined],
    ]);
  });

  it("labels a fieldset by its leading <label>, not the long text after it (Ashby EEO)", () => {
    setBody(`<fieldset><label>Race</label><div>${"Hispanic or Latino - A person of Cuban origin. ".repeat(10)}</div>
      <div><input type="radio" id="r1" name="race"><label for="r1">Asian</label></div>
      <div><input type="radio" id="r2" name="race"><label for="r2">White</label></div></fieldset>`);
    expect(fields()[0].desc.label).toBe("Race");
  });

  it("groups nameless radios wrapped one by one under their question (Gem)", () => {
    const opt = (t: string, i: number) =>
      `<div><input type="radio" id="${t}${i}"><label for="${t}${i}">${t}</label></div>`;
    const q = (title: string, i: number) =>
      `<div><div>${title}</div><div>${["Yes", "No", "N/A"].map((t) => opt(t, i)).join("")}</div></div>`;
    setBody(q("Will you require sponsorship?", 1) + q("Have you worked here before?", 2));
    expect(fields().map((h) => [h.desc.kind, h.desc.label, h.desc.options])).toEqual([
      ["radio_group", "Will you require sponsorship?", ["Yes", "No", "N/A"]],
      ["radio_group", "Have you worked here before?", ["Yes", "No", "N/A"]],
    ]);
  });

  it("keeps same-named option boxes of different questions apart (Ashby survey)", () => {
    const q = (title: string, opt: string, i: number) => `<fieldset><label>${title}</label>
        <label><input type="checkbox" id="o${i}" name="${opt}">${opt}</label>
        <label><input type="checkbox" id="p${i}" name="I prefer not to answer">I prefer not to answer</label></fieldset>`;
    setBody(q("Sexual orientation", "Gay", 1) + q("Ethnicity", "White", 2));
    expect(fields().map((h) => [h.desc.label, h.desc.options])).toEqual([
      ["Sexual orientation", ["Gay", "I prefer not to answer"]],
      ["Ethnicity", ["White", "I prefer not to answer"]],
    ]);
  });

  it("consent radio groups (Avature/EA) are consent fields; background-check and Yes/No ones are not", () => {
    setBody(`<fieldset><legend>By selecting "Consent", you consent that EA will process your personal data as described in the Candidate Privacy Notice. *</legend>
        <div role="radiogroup" aria-required="true"><label><input type="radio" name="p"> Consent</label><label><input type="radio" name="p"> Do Not Consent</label></div></fieldset>
      <fieldset><legend>Do you consent to a background check?</legend><label><input type="radio" name="b"> I consent</label><label><input type="radio" name="b"> I do not consent</label></fieldset>
      <fieldset><legend>Do you agree to relocate?</legend><label><input type="radio" name="r"> Yes</label><label><input type="radio" name="r"> No</label></fieldset>`);
    const hs = fields();
    expect(hs[0].desc).toMatchObject({ kind: "radio_group", required: true, options: ["Consent", "Do Not Consent"] });
    expect(hs.map((h) => h.consent)).toEqual([true, false, false]);
    expect(consentPair(["Do Not Acknowledge", "Acknowledge"])).toEqual([1, 0]);
    expect(consentPair(["Select…", "Yes, I agree", "No, I do not agree"])).toEqual([1, 2]);
    expect(consentPair(["Yes", "No"])).toBeNull();
    expect(consentPair(["Yes - I consent to texts", "No - I do not consent to texts"])).toEqual([0, 1]);
    // Ramp: an SMS opt-in is a consent question, and an optional one.
    setBody(`<fieldset><legend>I agree to receive text message updates regarding my application. Privacy Policy</legend>
      <label><input type="radio" name="sms"> Yes - I consent to receiving text messages</label>
      <label><input type="radio" name="sms"> No - I do not consent to receiving text messages</label></fieldset>`);
    expect(fields()[0].consent).toBe(true);
    expect(RE_OPTIONAL_CONSENT.test(fields()[0].desc.label)).toBe(true);
    // A Yes/No opt-in is one with bare answers; CI&T's answers state where the candidate lives.
    const opt = (o: string) => `<label><input type="radio" name="y"> ${o}</label>`;
    setBody(`<fieldset><legend>Receive alerts for similar jobs?</legend>${opt("Yes")}${opt("No")}</fieldset>`);
    expect(fields()[0].consent).toBe(true);
    setBody(`<fieldset><legend>On-site availability every day? In case you are considered for other open positions.</legend>
      ${opt("Yes, I live near the office and can go every day.")}${opt("No, I can't go every day.")}</fieldset>`);
    expect(fields()[0].consent).toBe(false);
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

  it("a 'Select files' upload button is not a dropdown (Workday: clicking it opens the file picker)", () => {
    setBody(
      `<div><label>Resume/CV</label><div data-automation-id="file-upload-drop-zone">Drop files here or ` +
        `<button type="button" data-automation-id="select-files">Select files</button></div>` +
        `<input type="file" data-automation-id="file-upload-input-ref" style="display:none"></div>`,
    );
    expect(fields().map((h) => h.desc.kind)).toEqual(["file"]);
  });

  it("a trigger whose aria-label names only its value falls back to the question (Workday questionnaire)", () => {
    setBody(
      `<div><fieldset><legend><div id="rich-label47"><p><b>Do you hold any licenses?</b><abbr>*</abbr></p></div></legend>` +
        `<div><div><div><button type="button" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button>` +
        `<input type="text" style="display:none"></div></div></div></fieldset></div>`,
    );
    expect(fields()[0].desc).toMatchObject({ kind: "dropdown", label: "Do you hold any licenses?", required: true });
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

  it("an AJAX widget's hidden select with no options leaves the list unknown", () => {
    setBody(`<div><label>Skills</label><span class="select2-selection">Select…</span>
      <select multiple style="display:none"><option value=""></option></select></div>`);
    const [h] = fields();
    expect(h.desc).toMatchObject({ kind: "dropdown", optionsKnown: false, multiple: true });
    expect(h.desc.options).toBeUndefined();
    expect(h.hiddenSelect).toBeTruthy();
  });

  it("a popup still showing its loading row is not the options list yet", () => {
    setBody(`<div><label>Country</label><span class="select2-selection">Select…</span></div>`);
    const [h] = fields();
    const before = snapshot();
    document.body.insertAdjacentHTML("beforeend", `<ul><li role="option" class="loading-results">Searching…</li></ul>`);
    expect(findOptionsContainer(h, before)).toBeNull();
    document.querySelector("ul")!.innerHTML = `<li role="option">Canada</li><li role="option">Chile</li>`;
    expect(findOptionsContainer(h, before)).toBe(document.querySelector("ul"));
  });

  it("typeaheads: combobox inputs, aria-autocomplete, and location inputs with aria-controls or a picked-value input", () => {
    setBody(`<div><label for="a">School</label><input id="a" role="combobox"></div>
      <div><label for="b">Skills</label><input id="b" aria-autocomplete="list"></div>
      <div><label for="c">Location</label><input id="c" aria-controls="sugg"></div>
      <div><label for="d">Nickname</label><input id="d" aria-controls="x"></div>
      <div><label for="e">Current location</label><input id="e" name="location"><input type="hidden" name="selectedLocation"></div>
      <div><label for="f">City</label><input id="f" name="city"><input type="hidden" name="token"></div>`);
    expect(fields().map((h) => h.desc.kind)).toEqual([
      "typeahead",
      "typeahead",
      "typeahead",
      "text",
      "typeahead",
      "text",
    ]);
  });

  it("an open dropdown's popup listbox and search box are not separate fields", () => {
    setBody(`<div><label>Country</label><div role="combobox" aria-expanded="true" aria-controls="pop">Select…</div></div>
      <div id="pop"><input type="text" placeholder="Filter"><div role="listbox"><div role="option">Canada</div></div></div>
      <div><label>School</label><input role="combobox" aria-controls="sugg">
      <ul id="sugg" role="listbox"><li role="option">UBC</li></ul></div>
      <div><label>Pick one</label><div role="listbox"><div role="option">A</div></div></div>`);
    expect(fields().map((h) => [h.desc.label, h.desc.kind])).toEqual([
      ["Country", "dropdown"],
      ["School", "typeahead"],
      ["Pick one", "dropdown"],
    ]);
  });

  it("native multiple select → multiselect", () => {
    setBody(`<label>Langs <select multiple><option>EN</option><option>FR</option></select></label>`);
    expect(fields()[0].desc.kind).toBe("multiselect");
  });
});

describe("sections (§11.5)", () => {
  it("scopes a legend to its fieldset and names heading-less education blocks (Greenhouse)", () => {
    setBody(`<h2>Apply for this job</h2>
      <fieldset><legend>Phone</legend><label>Country <input name="c"></label></fieldset>
      <label>LinkedIn <input name="l"></label>
      <div class="education--container"><label>End date year <input name="y"></label></div>`);
    expect(fields().map((h) => h.desc.section)).toEqual(["Phone", "Apply for this job", "Education"]);
  });
});

describe("skipping and visibility (§11.3, §11.6)", () => {
  it("skips hidden, disabled, readonly, password, search, captcha, nav and cookie-banner fields", () => {
    setBody(`<nav><input placeholder="Search jobs"></nav>
      <div id="onetrust-banner"><label><input type="checkbox"> Accept cookies</label></div>
      <div role="dialog" aria-label="Cookie notice banner"><label><input type="checkbox"> Analytics</label></div>
      <footer><label>Select region <select><option>English (US)</option></select></label></footer>
      <div class="newsletter-signup"><form><label>Get industry insights <input type="email"></label></form></div>
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

  it("skips a phone's country picker named only by its value (Recruitee)", () => {
    setBody(`<label for="t">Phone number</label><div><div><button type="button" aria-haspopup="listbox" aria-expanded="false"
      aria-label="Select country calling code: Netherlands" aria-controls="m">Netherlands</button>
      <div id="m" role="listbox" aria-labelledby="b"></div></div><input type="tel" id="t" name="candidate.phone"></div>`);
    expect(fields().map((h) => h.desc.label)).toEqual(["Phone number"]);
  });

  it("leaves interview-recording opt-ins to the profile, not the consent settings (Palantir)", () => {
    setBody(`<fieldset><legend>We may use AI notetakers to transcribe conversations. Do you consent?</legend>
      <label><input type="radio" name="n"> Yes, I consent</label><label><input type="radio" name="n"> No, I do not consent</label></fieldset>`);
    expect(fields()[0].consent).toBe(false);
  });

  it("treats a phone box holding only a dial code as empty (Recruitee)", () => {
    setBody(
      `<label>Phone number <input type="tel" value="+31"></label><label>Mobile <input type="tel" value="+1 604 555 1234"></label>`,
    );
    expect(fields().map((h) => h.prefilled)).toEqual([false, true]);
  });

  it("treats a leading empty-valued option as a prompt, not a prefilled answer (Lever)", () => {
    setBody(`<label>School <select><option value="">Click Here (If you encounter an issue, …)</option>
      <option>Aalborg University</option><option value="">None</option></select></label>`);
    const [h] = fields();
    expect(h.prefilled).toBe(false);
    expect(h.desc.options).toEqual(["Aalborg University", "None"]);
  });

  it("labels an upload named only 'Choose a file or drop it here' by its context (SmartRecruiters)", () => {
    setBody(`<form><div><h3>Resume</h3><label for="u">Choose a file or drop it here</label><input type="file" id="u"></div>
      <div><label for="n">Name</label><input id="n"></div></form>`);
    expect(fields()[0].desc.label).toBe("Resume");
  });

  it("skips a résumé uploader whose own panel offers to autocomplete the application (SmartRecruiters)", () => {
    setBody(`<form><div><h3>Easy Apply</h3><p>Choose an option to autocomplete your application.</p>
        <div><label for="a">Choose a file or drop it here</label><input type="file" id="a"></div></div>
      <div><h3>Resume</h3><div><label for="b">Choose a file or drop it here</label><input type="file" id="b"></div></div>
      <label>Name <input></label></form>`);
    expect(fields().map((h) => h.desc.label)).toEqual(["Resume", "Name"]);
  });

  it("skips a résumé uploader that only autofills the form (Ashby)", () => {
    setBody(`<div><input type="file" aria-describedby="h"><p id="h">Upload your resume here to autofill key application fields.</p></div>
      <div><label for="r">Resume</label><input type="file" id="r"></div>`);
    expect(fields().map((h) => h.desc.label)).toEqual(["Resume"]);
  });

  it("flags payment and government-id fields as sensitive", () => {
    setBody(
      `<label>Card number <input autocomplete="cc-number"></label><label>Social Insurance Number <input></label>`,
    );
    expect(fields().map((h) => h.sensitive)).toEqual([true, true]);
  });

  it("does not flag a résumé upload whose label runs into status text as sensitive (Lever)", () => {
    setBody(`<label>Resume/CV ✱ ATTACH RESUME/CV<input type="file"><span>Couldn't auto-read resume.</span></label>`);
    expect(fields()[0].sensitive).toBe(false);
  });
});

describe("job context (§11.7)", () => {
  it("keeps the text above the form when the page has no description (Lever's apply page)", () => {
    setBody(`<div class="posting-headline"><h2>Infrastructure Engineer, Internship</h2><div>Washington, D.C. / Internship</div></div>
      <form><label>Full name <input></label><p>Not part of the header</p></form>`);
    const jc = extractJobContext(document, location);
    expect(jc.text).toBe("");
    expect(jc.header).toMatch(/^Infrastructure Engineer, Internship Washington, D\.C\. \/ Internship/);
    expect(jc.header).not.toContain("Not part of the header");
  });

  it('finds a description titled "What we are looking for" (MongoDB)', () => {
    setBody(`<form><input placeholder="Search"></form><h1>Software Engineer Intern, Dublin</h1>
      <div><p>${"We build databases. ".repeat(12)}</p><h3>What we are looking for in you (qualifications)</h3><p>Java</p></div>`);
    expect(extractJobContext(document, location).text).toContain("What we are looking for");
  });

  it("decodes a JSON-LD description escaped twice (Brex)", () => {
    const description = "&lt;div class=&quot;intro&quot;&gt;&lt;p&gt;Why join us&lt;/p&gt;&lt;/div&gt;";
    setBody(`<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", description })}</script>`);
    expect(extractJobContext(document, location).text).toBe("Why join us");
  });

  it("reads the job's location from its JSON-LD", () => {
    const ld = (posting: object) =>
      setBody(
        `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", description: "x", ...posting })}</script>`,
      );
    ld({ jobLocation: [{ "@type": "Place", address: "Dublin, Ireland" }] });
    expect(extractJobContext(document, location).location).toBe("Dublin, Ireland");
    ld({
      jobLocation: {
        address: { addressLocality: "San Francisco", addressRegion: "California", addressCountry: "USA" },
      },
    });
    expect(extractJobContext(document, location).location).toBe("San Francisco, California, USA");
    ld({ jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { "@type": "Country", name: "Canada" } });
    expect(extractJobContext(document, location).location).toBe("Remote (Canada)");
    ld({});
    expect(extractJobContext(document, location).location).toBeUndefined();
    // Greenhouse: no JSON-LD, a location label under the title.
    setBody(`<h1>Engineer</h1><div class="job__location"><svg></svg>San Francisco, California, United States</div>
      <form><div class="location-field"><label>Location <input></label></div></form>`);
    expect(extractJobContext(document, location).location).toBe("San Francisco, California, United States");
  });
});
