import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBody, stubLayout } from "./dom";
import { addEntries } from "../../src/content/fill/sections";
import { newScanState, scan } from "../../src/content/scan/fields";
import type { EntryCounts } from "../../src/shared/types";

beforeAll(stubLayout);
beforeEach(() => setBody(""));

const none: EntryCounts = { experience: 0, education: 0, certifications: 0, languages: 0, projects: 0, websites: 0 };

// Workday "My Experience" (no <form>, buttons without a type): each Add renders a numbered entry asynchronously;
// the first Education entry is always open.
function workdaySection(title: string, open = 0) {
  const entry = (n: number) =>
    `<div role="group"><h5>${title} ${n}</h5>${n > 1 ? "<button>Delete</button>" : ""}<input></div>`;
  return `<div role="group" data-title="${title}"><h4>${title}</h4>${Array.from({ length: open }, (_, i) => entry(i + 1)).join("")}
    <button data-automation-id="add-button">${open ? "Add Another" : "Add"}</button></div>`;
}

function wireAdds() {
  const clicks: Record<string, number> = {};
  for (const g of document.querySelectorAll<HTMLElement>("[data-title]")) {
    const title = g.dataset.title!;
    g.querySelector("button[data-automation-id=add-button]")!.addEventListener("click", (e) => {
      clicks[title] = (clicks[title] ?? 0) + 1;
      const btn = e.currentTarget as HTMLElement;
      setTimeout(() => {
        const n = g.querySelectorAll("h5").length + 1;
        btn.insertAdjacentHTML(
          "beforebegin",
          `<div role="group"><h5>${title} ${n}</h5><button>Delete</button><input></div>`,
        );
        btn.textContent = "Add Another";
      }, 30);
    });
  }
  return clicks;
}

const entries = (title: string) => document.querySelectorAll(`[data-title="${title}"] h5`).length;

describe("addEntries", () => {
  it("opens only the entries the profile has", async () => {
    setBody(
      `<h3>My Experience</h3>${workdaySection("Work Experience")}${workdaySection("Education", 1)}` +
        `${workdaySection("Certifications")}${workdaySection("Languages")}<h4>Resume/CV</h4><button>Select files</button>`,
    );
    const clicks = wireAdds();
    await addEntries({ ...none, experience: 2, education: 1, languages: 1 }, new AbortController().signal);
    expect([entries("Work Experience"), entries("Education"), entries("Certifications"), entries("Languages")]).toEqual(
      [2, 1, 0, 1],
    );
    expect(clicks).toEqual({ "Work Experience": 2, Languages: 1 });
  });

  it("labels each new entry's fields with its numbered section", async () => {
    setBody(workdaySection("Work Experience"));
    wireAdds();
    await addEntries({ ...none, experience: 2 }, new AbortController().signal);
    expect(scan(newScanState()).handles.map((h) => h.desc.section)).toEqual(["Work Experience 1", "Work Experience 2"]);
  });

  it("adds to a section that already has entries", async () => {
    setBody(workdaySection("Education", 1));
    wireAdds();
    await addEntries({ ...none, education: 3 }, new AbortController().signal);
    expect(entries("Education")).toBe(3);
  });

  it("does nothing when the profile has no entries", async () => {
    setBody(workdaySection("Work Experience"));
    const clicks = wireAdds();
    await addEntries(none, new AbortController().signal);
    expect(clicks).toEqual({});
  });

  it("never repeats an Add click that added nothing countable", async () => {
    setBody(`<form><h4>Work Experience</h4><button type="button" id="b">Add</button></form>`);
    let clicks = 0;
    document.getElementById("b")!.addEventListener("click", () => clicks++);
    await addEntries({ ...none, experience: 3 }, new AbortController().signal);
    expect(clicks).toBe(1);
  });

  it("never clicks an Add button that would submit its form", async () => {
    setBody(`<form><h4>Work Experience</h4><button id="b">Add</button></form>`);
    let clicks = 0;
    document.getElementById("b")!.addEventListener("click", () => clicks++);
    await addEntries({ ...none, experience: 1 }, new AbortController().signal);
    expect(clicks).toBe(0);
  });

  it("ignores Add buttons of unrelated sections", async () => {
    setBody(
      `<form><h4>Skills</h4><button type="button" id="b">Add</button><h4>Work Experience</h4><button type="button" id="f">Add file</button></form>`,
    );
    let clicks = 0;
    for (const b of document.querySelectorAll("button")) b.addEventListener("click", () => clicks++);
    await addEntries({ ...none, experience: 1 }, new AbortController().signal);
    expect(clicks).toBe(0);
  });
});
