// Repeatable sections (Workday "Work Experience" → Add / Add Another): open as many entries as the profile has,
// before the scan, so their fields get filled. A section the profile has nothing for is never opened.
import { RE_FORBIDDEN_CLICK } from "../../shared/constants";
import { collapse } from "../../shared/normalize";
import type { EntryCounts } from "../../shared/types";
import { isVisible } from "../scan/visibility";
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

/** Entries already open: numbered entry headings ("Education 2"), Delete buttons, or an always-open first entry. */
function entryCount(section: Element): number {
  let numbered = 0;
  let deletes = 0;
  for (const h of section.querySelectorAll(HEADINGS)) if (/\s\d+$/.test(collapse(h.textContent ?? ""))) numbered++;
  for (const b of section.querySelectorAll("button,[role=button]"))
    if (/^(delete|remove)$/i.test(collapse(b.textContent ?? ""))) deletes++;
  const open = section.querySelector("input:not([type=hidden]),textarea,select") ? 1 : 0;
  return Math.max(numbered, deletes, open);
}

/** The first visible Add button per kind, named by its own text or the nearest heading before it. */
function findAdders(): Adder[] {
  const out: Adder[] = [];
  let heading: Element | null = null;
  for (const el of document.body.querySelectorAll<HTMLElement>(`${HEADINGS},button,[role=button],a`)) {
    if (el.matches(HEADINGS)) {
      heading = el;
      continue;
    }
    const label = collapse(el.textContent || el.getAttribute("aria-label") || "");
    if (!RE_ADD.test(label) || label.length > 40) continue;
    const head = heading;
    heading = null; // a heading names only the first Add button after it
    const kind = RE_BARE_ADD.test(label) ? head && kindOf(collapse(head.textContent ?? "")) : kindOf(label);
    if (!kind || out.some((a) => a.kind === kind) || !clickable(el, label) || !isVisible(el)) continue;
    let section: Element | null = head?.parentElement ?? el.parentElement;
    while (section && !section.contains(el)) section = section.parentElement;
    section ??= document.body;
    out.push({ kind, button: el, section, count: entryCount(section) });
  }
  return out;
}

/** Clicks Add until each section holds as many entries as the profile; resolves once they are on the page. */
export async function addEntries(want: EntryCounts, signal: AbortSignal): Promise<void> {
  if (!Object.values(want).some(Boolean)) return;
  const stalled = new Set<Kind>();
  const needed = (adders: Adder[]) => adders.filter((a) => !stalled.has(a.kind) && a.count < want[a.kind]);
  let todo = needed(findAdders());
  if (!todo.length) return;
  // Pages may focus or scroll to the new entry.
  await holdScroll(async () => {
    // One click per section per round: Workday renders each new entry asynchronously.
    for (let round = 0; todo.length && round < 10 && !signal.aborted; round++) {
      dispatching(() => todo.forEach((a) => a.button.click()));
      await waitFor(() => todo.every((a) => !a.section.isConnected || entryCount(a.section) > a.count), 3000);
      // A click that added nothing countable (opened a dialog, unknown markup) is never repeated.
      const now = findAdders();
      for (const a of todo) if ((now.find((n) => n.kind === a.kind)?.count ?? 0) <= a.count) stalled.add(a.kind);
      todo = needed(now);
    }
  });
}
