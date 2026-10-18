import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBody, stubLayout } from "./dom";
import { newScanState, scan } from "../../src/content/scan/fields";
import { harvestOptions, openDropdown } from "../../src/content/fill/dropdown";
import { fillTypeahead } from "../../src/content/fill/typeahead";

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
    const r = await fillTypeahead(
      { ...h, el: h.searchInput! },
      "Python programming",
      "Python programming",
      async () => null,
    );
    expect(r.outcome).toBe("flag");
    expect(h.searchInput!.value).toBe("");
  });
});
