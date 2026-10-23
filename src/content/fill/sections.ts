// Repeatable sections (Workday "Work Experience" → Add / Add Another): open as many entries as the profile has,
// before the scan, so their fields get filled. A section the profile has nothing for is never opened. Entries that
// open as an editor with its own Save (SmartRecruiters) are saved once filled; nothing else is ever saved.
import { RE_FORBIDDEN_CLICK } from "../../shared/constants";
import { collapse } from "../../shared/normalize";
import type { EntryCounts } from "../../shared/types";
import { shownText } from "../scan/labels";
import { deepQueryAll, shadowOf } from "../scan/traverse";
import { composedContains, isVisible, parentOf } from "../scan/visibility";
import { dispatching, holdScroll, isForbiddenClick, waitFor } from "./events";

type Kind = keyof EntryCounts;
const KINDS: [Kind, RegExp][] = [
  ["certifications", /certific|licen[cs]e/i],
  ["languages", /^(add )?(spoken )?languages?\b/i],
  ["education", /education|academic|schools?\b|degrees?\b/i],
  ["experience", /^(?!.*volunteer).*(experience|employment|work history)/i],
  ["projects", /^(add )?projects?\b/i],
  ["websites", /websites?|\blinks?\b|portfolio/i],
];
const HEADINGS = "h1,h2,h3,h4,h5,h6,[role=heading]";
const RE_ADD = /^\+?\s*add\b/i;
/** An Add button that names nothing ("Add", "Add Another"): its section heading says what it adds. */
const RE_BARE_ADD = /^\+?\s*add( another| more| new)?( entry| item)?$/i;
/** An entry editor's own Save. "Save and continue" / "Save & Next" move the application on and never match. */
const RE_SAVE = /^save$/i;
const BUTTONS = "button,[role=button]";

/** Rendered text: SmartRecruiters' buttons and headings show theirs through <slot>s. */
const textOf = (el: Element) => collapse(shownText(el)) || collapse(el.getAttribute("aria-label") ?? "");

/** Elements in document order, through shadow roots (SmartRecruiters' sections live in them). */
function* deepElements(root: ParentNode): Generator<Element> {
  for (const el of root.children) {
    yield el;
    const sr = shadowOf(el);
    if (sr) yield* deepElements(sr);
    yield* deepElements(el);
  }
}

interface Adder {
  kind: Kind;
  button: HTMLElement;
  section: Element;
  count: number;
}

const kindOf = (text: string) => KINDS.find(([, re]) => re.test(text))?.[0];

/** Workday's Add buttons sit in no <form> and default to type=submit, which submits nothing: only the text guard
 * of isForbiddenClick applies to such a button. */
const clickable = (el: HTMLElement, label: string) =>
  el instanceof HTMLButtonElement && !el.form
    ? !RE_FORBIDDEN_CLICK.test(`${label} ${el.getAttribute("aria-label") ?? ""}`)
    : !isForbiddenClick(el);

/**
 * Entries already there: numbered entry headings ("Education 2"), saved entries' Delete buttons plus open editors'
 * Save buttons, or an always-open first entry.
 */
function entryCount(section: Element): number {
  const numbered = deepQueryAll(HEADINGS, section).filter((h) => /\s\d+$/.test(textOf(h))).length;
  const buttons = deepQueryAll(BUTTONS, section).map(textOf);
  // SmartRecruiters names the entry: "Delete experience Software Engineer Intern FORM Swim".
  const entries = buttons.filter((t) => /^(delete|remove)\b/i.test(t) || RE_SAVE.test(t)).length;
  const open = deepQueryAll("input:not([type=hidden]),textarea,select", section).length ? 1 : 0;
  return Math.max(numbered, entries, open);
}

/** Entries can render beside the heading's own wrapper (SmartRecruiters): the section runs to the next such heading. */
function widen(section: Element, head: Element): Element {
  const same = head.matches("[role=heading]") ? "[role=heading]" : head.tagName;
  for (let p = parentOf(section); p && p !== document.body; p = parentOf(p)) {
    if (deepQueryAll(same, p).some((h) => h !== head && !composedContains(section, h))) break;
    section = p;
  }
  return section;
}

/** Would submit a form: an entry Save never does, the application's own button may. */
const submitsForm = (b: Element) => b instanceof HTMLButtonElement && b.type === "submit" && !!b.form;

const saveButtons = () =>
  deepQueryAll(BUTTONS).filter((b) => RE_SAVE.test(textOf(b)) && !submitsForm(b) && isVisible(b));

/** The first visible Add button per kind, named by its own text or the nearest heading before it. */
function findAdders(): Adder[] {
  const out: Adder[] = [];
  let heading: Element | null = null;
  for (const el of deepElements(document.body)) {
    if (el.matches(HEADINGS)) {
      heading = el;
      continue;
    }
    if (!(el instanceof HTMLElement) || !el.matches(`${BUTTONS},a`)) continue;
    const label = textOf(el);
    if (!RE_ADD.test(label) || label.length > 40) continue;
    const head = heading;
    heading = null; // a heading names only the first Add button after it
    const kind = RE_BARE_ADD.test(label) ? head && kindOf(textOf(head)) : kindOf(label);
    if (!kind || out.some((a) => a.kind === kind) || !clickable(el, label) || !isVisible(el)) continue;
    let section: Element | null = parentOf(head ?? el);
    while (section && !composedContains(section, el)) section = parentOf(section);
    section ??= document.body;
    if (head) section = widen(section, head);
    out.push({ kind, button: el, section, count: entryCount(section) });
  }
  return out;
}

/**
 * Clicks Add until each section holds as many entries as the profile; resolves once they are on the page, with the
 * Save buttons of the entry editors those clicks opened (for saveEntries).
 */
export async function addEntries(want: EntryCounts, signal: AbortSignal): Promise<HTMLElement[]> {
  if (!Object.values(want).some(Boolean)) return [];
  let adders = findAdders().filter((a) => a.count < want[a.kind]);
  if (!adders.length) return [];
  const before = new Set(saveButtons());
  // Pages may focus or scroll to the new entry.
  await holdScroll(async () => {
    // One click at a time: SmartRecruiters opens each entry as an editor outside the Add button's section, so only a
    // new Save button shows which click it answers.
    for (const kind of adders.map((a) => a.kind)) {
      let adder = adders.find((a) => a.kind === kind);
      for (let have = adder?.count ?? 0; adder && have < want[kind] && !signal.aborted; have++) {
        const { button, section, count } = adder;
        const editors = saveButtons().length;
        dispatching(() => button.click());
        const grew = await waitFor(
          () => !section.isConnected || entryCount(section) > count || saveButtons().length > editors,
          3000,
        );
        // A click that added nothing countable (opened a dialog, unknown markup) is never repeated.
        if (!grew) break;
        // Workday re-renders its sections: Add becomes "Add Another".
        adders = findAdders();
        adder = adders.find((a) => a.kind === kind);
      }
    }
  });
  return saveButtons().filter((b) => !before.has(b));
}

/**
 * Saves the entries addEntries opened, once their fields are filled. Only those editors' own Save buttons: never the
 * application's Save/Submit/Next, and never a button that would submit a form.
 */
export async function saveEntries(saves: HTMLElement[]): Promise<void> {
  await holdScroll(async () => {
    for (const b of saves) {
      if (!b.isConnected || !isVisible(b) || submitsForm(b)) continue;
      dispatching(() => b.click());
      // An editor that fails validation stays open, its fields badged for the user.
      await waitFor(() => !b.isConnected || !isVisible(b), 2000);
    }
  });
}
