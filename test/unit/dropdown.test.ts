import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBody, stubLayout } from "./dom";
import { newScanState, scan, type FieldHandle } from "../../src/content/scan/fields";
import { fillDropdown, harvestOptions, openDropdown, searchOptions } from "../../src/content/fill/dropdown";
import { fillTypeahead } from "../../src/content/fill/typeahead";
import { fill } from "../../src/content/fill/engine";
import { realClick } from "../../src/content/fill/events";
import { fillFile, findDropzones } from "../../src/content/fill/file";
import { dropdownText, readValue } from "../../src/content/fill/verify";

beforeAll(() => {
  stubLayout();
  // happy-dom rejects the case-insensitive attribute flag ([class*=loading i]) that Chrome supports.
  const proto = Element.prototype as unknown as Record<"querySelectorAll" | "matches", (s: string) => unknown>;
  for (const m of ["querySelectorAll", "matches"] as const) {
    const orig = proto[m];
    proto[m] = function (this: Element, s: string) {
      return orig.call(this, s.replace(/ i\]/g, "]"));
    };
  }
});
beforeEach(() => setBody(""));

/** Select2-like widget: mousedown opens a popup (linked by aria-controls) holding `rows`. */
function select2(rows: string) {
  setBody(`<div><label>Country</label>
    <span role="combobox" aria-haspopup="true" aria-expanded="false" aria-controls="res">Select…</span></div>
    <ul id="res" role="listbox" hidden></ul>`);
  const t = document.querySelector<HTMLElement>("[role=combobox]")!;
  const ul = document.getElementById("res")!;
  t.addEventListener("mousedown", () => {
    t.setAttribute("aria-expanded", "true");
    ul.hidden = false;
    ul.innerHTML = rows;
  });
  t.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    t.setAttribute("aria-expanded", "false");
    ul.hidden = true;
  });
  return { h: scan(newScanState()).handles[0], ul };
}

describe("remote dropdowns (Select2 AJAX)", () => {
  it("an opened list that settles empty gives up without the slow fallback", async () => {
    const { h, ul } = select2(`<li role="option" class="select2-results__message">No results found</li>`);
    const t0 = Date.now();
    expect(await openDropdown(h)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(700);
    expect(ul.hidden).toBe(true);
  });

  it("does not read react-select's notice in an empty listbox as an option", async () => {
    const { h, ul } = select2(`<div class="select__menu-notice select__menu-notice--no-options">Start typing...</div>`);
    expect(await openDropdown(h)).toBeNull();
    expect(ul.hidden).toBe(true);
  });

  it("a short harvest skips a list that is still loading more pages", async () => {
    const { h } = select2(
      `<li role="option">Albania</li><li role="option">Algeria</li><li role="option">Loading more results…</li>`,
    );
    expect(await harvestOptions(h, 400)).toBeNull();
    expect(await harvestOptions(h)).toEqual(["Albania", "Algeria"]);
  });

  it("a dropdown search with no suggestions flags and clears the search box instead of keeping the typed text", async () => {
    setBody(`<div><label>Skills</label><span role="combobox" aria-haspopup="true" aria-expanded="false">
      <input type="search" class="select2-search__field"></span></div>`);
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Python programming", "Python programming", async () => null);
    expect(r.outcome).toBe("flag");
    expect(h.searchInput!.value).toBe("");
  });

  it("a remote search dropdown picks the AI's choice even if the list closed while it chose, and verifies the pick", async () => {
    // react-select (Greenhouse location): typing lists suggestions; a pick shows in the control and empties the input.
    setBody(`<div><label>Location (City)</label><div class="select__control"><div class="select__value"></div>
      <input role="combobox" aria-haspopup="true" aria-expanded="false" aria-controls="menu"></div></div>
      <div id="menu" role="listbox" hidden></div>`);
    const h = scan(newScanState()).handles[0];
    const menu = document.getElementById("menu")!;
    const input = h.searchInput!;
    input.addEventListener("input", () => {
      menu.hidden = false;
      menu.innerHTML = `<div role="option">Vancouver, British Columbia, Canada</div><div role="option">Vancouver, Washington, United States</div>`;
    });
    // Delegated like React's handlers: a click on a detached option reaches nothing.
    menu.addEventListener("click", (e) => {
      if (!menu.contains(e.target as Node)) return; // happy-dom still bubbles from detached nodes
      h.el.querySelector(".select__value")!.textContent = (e.target as Element).textContent;
      input.value = "";
      menu.hidden = true;
    });
    // Another fill takes focus while the AI chooses: the list closes and its options are gone.
    const close = () => ((menu.hidden = true), (menu.innerHTML = ""));
    const r = await fillTypeahead(h, "Vancouver", "Vancouver", async () => (close(), 0));
    expect(r).toEqual({ outcome: "ok", shown: "Vancouver, British Columbia, Canada" });
    expect(h.el.textContent!.trim()).toBe("Vancouver, British Columbia, Canada");
  });

  it("a Workday prompt reads as empty, opens from its search box, searches on Enter and picks via the row label", async () => {
    // Another field's chips (Skills) are a listbox too; they must not be mistaken for this prompt's results.
    setBody(`<ul role="listbox" aria-label="Skills"><li role="option">Python</li></ul>
      <div><label for="fos">Field of Study</label><div data-automation-id="multiSelectContainer" tabindex="-1">
        <div data-automation-id="multiselectInputContainer">
          <input id="fos" placeholder="Search" enterkeyhint="search" aria-describedby="fos-sr">
          <div id="fos-sr" aria-hidden="true">0 items selected</div></div></div></div>`);
    const h = scan(newScanState()).handles.find((x) => x.desc.label === "Field of Study")!;
    expect(h.desc.kind).toBe("dropdown");
    expect(h.prefilled).toBe(false);
    expect(h.desc.currentValue).toBeUndefined();

    const all = ["Accounting", "Acting", "Computer Engineering", "Computer Science"];
    const input = h.searchInput!;
    let popup: HTMLElement | null = null;
    const show = (rows: string[]) => {
      popup?.remove();
      popup = document.createElement("div");
      popup.setAttribute("role", "listbox");
      popup.innerHTML = rows
        .map(
          (t) =>
            `<div role="option" aria-setsize="${rows.length}"><div data-automation-id="promptOption">${t}</div></div>`,
        )
        .join("");
      document.body.append(popup);
    };
    // Only the search box opens it; only the row's label takes a pick; Enter re-renders the popup with the hits.
    input.addEventListener("click", () => show(all.slice(0, 2)));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") popup?.remove();
      if (e.key !== "Enter") return;
      popup?.remove();
      setTimeout(() => show(all.filter((t) => t.includes(input.value))), 100);
    });
    document.addEventListener("click", (e) => {
      const label = (e.target as Element).closest?.('[data-automation-id="promptOption"]');
      if (!label) return;
      input.insertAdjacentHTML("afterend", `<div>${label.textContent}</div>`);
      popup?.remove();
    });

    expect(await searchOptions(h, "Computer")).toEqual(["Computer Engineering", "Computer Science"]);
    expect(await fillDropdown(h, ["Computer Science"])).toEqual({ outcome: "ok", shown: "Computer Science" });
  });

  it("a list too long to harvest is searched from its popup search box", async () => {
    const { h, ul } = select2(`<li role="option">Aalto University</li><li role="option">Loading more results…</li>`);
    ul.insertAdjacentHTML("beforebegin", `<input type="search" aria-controls="res" hidden>`);
    const box = document.querySelector<HTMLInputElement>("input")!;
    h.el.addEventListener("mousedown", () => (box.hidden = false));
    h.el.addEventListener("click", () => box.focus());
    box.addEventListener("input", () => {
      ul.innerHTML = `<li role="option" class="loading-results">Searching…</li>`;
      const q = box.value;
      setTimeout(() => {
        if (box.value !== q) return;
        const hits = ["University of British Columbia", "University of Northern British Columbia"];
        ul.innerHTML = hits.map((t) => `<li role="option">${t}</li>`).join("");
      }, 1000);
    });
    expect(await searchOptions(h, "British Columbia")).toEqual([
      "University of British Columbia",
      "University of Northern British Columbia",
    ]);
    expect(ul.hidden).toBe(true);
  });
});

describe("native selects too long to scan", () => {
  it("a 300+ option select is filled from the AI's choice among the options containing the query (Lever)", async () => {
    const schools = Array.from({ length: 400 }, (_, i) => `<option>School ${i}</option>`).join("");
    setBody(`<label>School <select><option value="">Click Here</option>${schools}
      <option>University of British Columbia - UBC</option><option>University of Northern British Columbia - UNBC</option>
      </select></label>`);
    const h = scan(newScanState()).handles[0];
    expect(h.desc).toMatchObject({ kind: "select", optionsKnown: false });
    const offered: string[][] = [];
    const deps = {
      documents: [],
      getDocument: async () => null,
      choose: async (_: unknown, __: string, options: string[]) => (offered.push(options), [0]),
      checkedByUs: new Set<Element>(),
      harvested: new Map<string, string[]>(),
      signal: new AbortController().signal,
    };
    const op = { type: "intended", answer: "University of British Columbia", query: "British Columbia" } as const;
    expect(await fill(h, op, deps)).toMatchObject({ outcome: "ok" });
    expect(offered).toEqual([
      ["University of British Columbia - UBC", "University of Northern British Columbia - UNBC"],
    ]);
    expect((h.el as HTMLSelectElement).value).toBe("University of British Columbia - UBC");
  });
});

const deps = () => ({
  documents: [],
  getDocument: async () => null,
  choose: async () => null,
  checkedByUs: new Set<Element>(),
  harvested: new Map<string, string[]>(),
  signal: new AbortController().signal,
});

describe("fill engine", () => {
  it("clicks Yes/No toggle pills even though they default to type=submit (Ashby)", async () => {
    setBody(`<div><label>Willing to relocate?</label><div>
      <button aria-pressed="false">Yes</button><button aria-pressed="false">No</button></div></div>`);
    for (const b of document.querySelectorAll("button"))
      b.addEventListener("click", () => b.setAttribute("aria-pressed", "true"));
    const h = scan(newScanState()).handles[0];
    expect(await fill(h, { type: "options", texts: ["Yes"] }, deps())).toMatchObject({ outcome: "ok" });
    expect(document.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("picks a Workable radio, whose role=radio wrapper holds the state", async () => {
    const opt = (v: string) =>
      `<div role="radio" aria-checked="false"><label><input type="radio" name="q" aria-hidden="true"><span>${v}</span></label></div>`;
    setBody(
      `<span id="ql">Eligible?</span><fieldset role="radiogroup" aria-labelledby="ql">${opt("YES")}${opt("NO")}</fieldset>`,
    );
    // Workable keeps its hidden radio unchecked and marks the wrapper instead.
    for (const input of document.querySelectorAll("input"))
      input.addEventListener("click", (e) => {
        e.preventDefault();
        input.closest("[role=radio]")!.setAttribute("aria-checked", "true");
      });
    const h = scan(newScanState()).handles[0];
    expect(await fill(h, { type: "options", texts: ["YES"] }, deps())).toMatchObject({ outcome: "ok" });
    expect(readValue(h)).toBe("YES");
  });

  it("a refused click fails that field instead of rejecting the whole fill", async () => {
    setBody(`<div role="radiogroup" aria-label="Relocate?">
      <a href="/next"><span role="radio" aria-checked="false">Yes</span></a><span role="radio" aria-checked="false">No</span></div>`);
    const h = scan(newScanState()).handles[0];
    await expect(fill(h, { type: "options", texts: ["Yes"] }, deps())).resolves.toMatchObject({ outcome: "failed" });
  });
});

describe("read-only input dropdowns (Workable)", () => {
  it("verifies the pick from the trigger input's own value", async () => {
    setBody(`<div><label><span id="l">Notice period</span>
      <input role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="lb" aria-labelledby="l" readonly placeholder="Select an option…"></label>
      <ul id="lb" role="listbox" hidden></ul></div>`);
    const input = document.querySelector("input")!;
    const lb = document.getElementById("lb")!;
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      lb.hidden = false;
      lb.innerHTML = `<li role="option">Available immediately</li><li role="option">1 week</li>`;
      for (const o of lb.children)
        o.addEventListener("click", () => {
          input.value = o.textContent!;
          lb.hidden = true;
        });
    });
    const h = scan(newScanState()).handles[0];
    expect(h.desc.kind).toBe("dropdown");
    expect(await fillDropdown(h, ["Available immediately"])).toMatchObject({ outcome: "ok" });
  });
});

describe("slow typeahead suggestions", () => {
  it("waits past the usual timeout while the field shows a loading spinner (Lever)", async () => {
    setBody(`<div><label for="loc">Current location</label><input id="loc" role="combobox">
      <div class="loading" hidden>Loading</div><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    const spinner = document.querySelector<HTMLElement>(".loading")!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener("input", () => {
      spinner.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        spinner.hidden = true;
        document.getElementById("res")!.innerHTML = `<div role="option">Langley, BC, CAN</div>`;
      }, 2600);
    });
    document.getElementById("res")!.addEventListener("click", (e) => {
      input.value = (e.target as HTMLElement).textContent!;
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, BC, CAN", async () => 0);
    expect(r).toMatchObject({ outcome: "ok", shown: "Langley, BC, CAN" });
  }, 10_000);
});

describe("text fills", () => {
  it("accepts a date the widget reformats (SmartRecruiters)", async () => {
    setBody(`<label>To <input id="to"></label>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      const m = /^(\d{4})-(\d{2})$/.exec(input.value);
      if (m) input.value = `${m[2]}/${m[1]}`;
    });
    const h = scan(newScanState()).handles[0];
    expect(await fill(h, { type: "text", value: "2026-08" }, deps())).toMatchObject({
      outcome: "ok",
      shown: "08/2026",
    });
  });
});

describe("dates split into Month / Day / Year boxes (Workday)", () => {
  const box = (part: string) =>
    `<div><input type="text" role="spinbutton" aria-label="${part}" inputmode="numeric" value=""></div>`;
  it("reads them as one date question and types each part into its box", async () => {
    setBody(`<div><label id="g-label">What is your expected graduation date?</label>
      <div role="group" aria-labelledby="g-label">${box("Month")}${box("Year")}</div></div>
      <div><label id="s-label">Earliest start date</label>
      <div role="group" aria-labelledby="s-label">${box("Month")}${box("Day")}${box("Year")}</div></div>`);
    const [grad, start] = scan(newScanState()).handles;
    expect(scan(newScanState()).handles).toHaveLength(2);
    expect(grad.desc).toMatchObject({
      kind: "date",
      label: "What is your expected graduation date?",
      placeholder: "MM/YYYY",
    });
    expect(start.desc.placeholder).toBe("MM/DD/YYYY");
    expect(await fill(grad, { type: "text", value: "May 2028" }, deps())).toMatchObject({
      outcome: "ok",
      shown: "05/2028",
    });
    expect(await fill(start, { type: "text", value: "2027-01-01" }, deps())).toMatchObject({
      outcome: "ok",
      shown: "01/01/2027",
    });
    expect(readValue(start)).toBe("01/01/2027");
  });
});

describe("clicks", () => {
  it("land inside a custom element's shadow root, where its listener is (SmartRecruiters)", () => {
    setBody(`<x-option></x-option>`);
    const host = document.querySelector<HTMLElement>("x-option")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<style></style><div role="option">Langley</div>`;
    let clicked = 0;
    sr.querySelector("div")!.addEventListener("click", () => clicked++);
    realClick(host);
    expect(clicked).toBe(1);
  });
});

describe("listbox kept inside the widget (Carvana)", () => {
  it("reads a closed list as no value", () => {
    setBody(`<div data-testid="Select"><button type="button" aria-haspopup="listbox"><div>Select answer</div>
      <span id="sel"></span></button><div role="listbox" style="display:none"><div role="option">Yes</div>
      <div role="option">No</div></div></div>`);
    const el = document.querySelector<HTMLElement>("[data-testid=Select]")!;
    const h = { el, desc: { kind: "dropdown" } } as unknown as FieldHandle;
    expect(dropdownText(h)).toBe("Select answer");
    document.getElementById("sel")!.textContent = "Yes";
    expect(dropdownText(h)).toBe("Select answer Yes");
  });
});

describe("typeahead verification", () => {
  it("does not take the typed query left in the box for the pick", async () => {
    setBody(`<div><label for="c">City</label><input id="c" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      document.getElementById("res")!.innerHTML = `<div role="option">Langley, BC, Canada</div>`;
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, BC, Canada", async () => 0);
    expect(r.outcome).toBe("mismatch");
  });

  it("fails instead of marking a cleared selection for review", async () => {
    setBody(`<div><label for="c">City</label><input id="c" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      document.getElementById("res")!.innerHTML = `<div role="option">Langley, BC, Canada</div>`;
    });
    document.getElementById("res")!.addEventListener("click", () => {
      // Some async widgets clear their search box before they commit the selected value.
      input.value = "";
      document.getElementById("res")!.replaceChildren();
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, BC, Canada", async () => 0);
    expect(r).toMatchObject({ outcome: "failed" });
  });

  it("reads the pick shown beside an emptied search box (react-select without classes, Epic Games)", async () => {
    setBody(`<div><label for="c">Country</label><div><div><div class="css-1-placeholder">Select</div><div>
      <input id="c" aria-autocomplete="list"></div></div><div id="menu"></div></div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      document.getElementById("menu")!.innerHTML =
        `<div id="react-select-2-option-38"><svg><title>Canada</title></svg><span>Canada</span><span>+1</span></div>`;
      document.getElementById("react-select-2-option-38")!.addEventListener("click", () => {
        input.value = "";
        document.getElementById("menu")!.innerHTML = "";
        document
          .querySelector(".css-1-placeholder")!
          .replaceWith(Object.assign(document.createElement("div"), { textContent: "Canada+1" }));
      });
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Canada", "Canada", async () => null);
    expect(r).toMatchObject({ outcome: "ok", shown: "Canada+1" });
  });
});

describe("how-heard typeaheads", () => {
  it('pick "Other" when the profile\'s source lists nothing (1Password)', async () => {
    setBody(`<div><label for="c">What brought you to this job posting</label><input id="c" role="combobox">
      <div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    let picked = "";
    input.addEventListener("input", () => {
      const hits = ["LinkedIn Jobs", "Other", "Otta"].filter((o) =>
        o.toLowerCase().startsWith(input.value.toLowerCase()),
      );
      document.getElementById("res")!.innerHTML = hits.map((o) => `<div role="option">${o}</div>`).join("");
      for (const o of document.querySelectorAll("[role=option]"))
        o.addEventListener("click", () => (input.value = picked = o.textContent!));
    });
    // Text that picks nothing is cleared.
    input.addEventListener("blur", () => (input.value = picked));
    const h = scan(newScanState()).handles[0];
    const r = await fill(h, { type: "intended", answer: "Company website" }, deps());
    expect(r).toMatchObject({ outcome: "ok", shown: "Other" });
  });
});

describe("slotted dropdown values", () => {
  it("reads a shadow-root trigger's value through its slot (SmartRecruiters' phone country)", () => {
    setBody(`<x-select><span slot="p">+1</span></x-select>`);
    const host = document.querySelector("x-select")!;
    host.attachShadow({ mode: "open" }).innerHTML =
      `<button role="combobox" aria-haspopup="listbox" aria-label="Country code"><!--lit--><slot name="p"></slot></button>`;
    const [h] = scan(newScanState()).handles;
    expect(h.desc).toMatchObject({ kind: "dropdown", label: "Country code", currentValue: "+1" });
  });
});

describe("file uploads", () => {
  const meta = {
    id: "cv",
    label: "CV",
    kind: "resume",
    fileName: "Ada.pdf",
    mimeType: "application/pdf",
    size: 1,
    isPrimaryResume: true,
    uploadedAt: 0,
  } as const;

  it("count as done when the widget lists the file inside its shadow root (SmartRecruiters)", async () => {
    setBody(`<div><label for="r">Resume</label><x-drop><input type="file" id="r"></x-drop></div>`);
    const drop = document.querySelector("x-drop")!;
    const list = drop.attachShadow({ mode: "open" });
    list.innerHTML = `<style>.ok::after{content:"uploaded"}</style><slot></slot>`;
    const input = document.querySelector<HTMLInputElement>("input")!;
    // The widget takes the file, empties its input and shows the name in its shadow root.
    input.addEventListener("change", () => {
      const name = input.files![0].name;
      input.value = "";
      list.append(Object.assign(document.createElement("span"), { textContent: name }));
    });
    const h = scan(newScanState()).handles[0];
    expect(await fillFile(h, meta, btoa("%PDF"))).toMatchObject({ outcome: "ok" });
  });

  it("set a dropzone's input kept on <body> without opening the file picker (Dropzone.js, Disney)", async () => {
    setBody(`<div class="upload-area"><button type="button">Upload Resume</button><span>PDF or DOCX</span></div>`);
    const input = Object.assign(document.createElement("input"), { type: "file" });
    document.body.append(input);
    let picker = false;
    input.addEventListener("click", (e) => (picker = !e.defaultPrevented));
    document.querySelector("button")!.addEventListener("click", () => input.click());
    input.addEventListener("change", () => (document.querySelector("span")!.textContent = input.files![0].name));
    const st = newScanState();
    const [h] = findDropzones(scan(st).handles, st);
    expect(await fillFile(h, meta, btoa("%PDF"))).toMatchObject({ outcome: "ok" });
    expect(picker).toBe(false);
  });
});

describe("place typeaheads", () => {
  it("search again by the place name when the full place finds nothing (SmartRecruiters)", async () => {
    setBody(`<div><label for="o">Office location</label><input id="o" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    const res = document.getElementById("res")!;
    input.addEventListener("input", () => {
      res.innerHTML =
        input.value === "Vancouver"
          ? `<div role="option">Vancouver, British Columbia, Canada</div>`
          : `<div role="option">Cannot find your city? Click here to fill in manually</div>`;
    });
    res.addEventListener("click", (e) => (input.value = (e.target as HTMLElement).textContent!));
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Vancouver, BC", "Vancouver, BC", async () => 0);
    expect(r).toMatchObject({ outcome: "ok", shown: "Vancouver, British Columbia, Canada" });
    expect(input.value).toBe("Vancouver, British Columbia, Canada");
  });

  it("search by the country when the picker lists only countries (Airwallex)", async () => {
    setBody(`<div><label for="o">Location</label><input id="o" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    const res = document.getElementById("res")!;
    input.addEventListener("input", () => {
      res.innerHTML = /^canada$/i.test(input.value) ? `<div role="option">Canada</div>` : "";
    });
    res.addEventListener("click", (e) => (input.value = (e.target as HTMLElement).textContent!));
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, British Columbia, Canada", async () => 0);
    expect(r).toMatchObject({ outcome: "ok", shown: "Canada" });
  }, 15000);
});
