// §14.5 custom dropdowns: open, harvest (incl. virtualized lists), select, verify, sync hidden select.
import { OPTION_SELECTORS, RE_NO_OPTIONS, RE_PLACEHOLDER_OPTION } from "../../shared/constants";
import { collapse, normalize } from "../../shared/normalize";
import type { FieldHandle } from "../scan/fields";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { isTextInput } from "../scan/widgets";
import { dispatching, focus, key, realClick, setNativeValue, sleep, typeText, waitFor } from "./events";
import type { FillResult } from "./native";
import { dropdownText, isOn, sameValue } from "./verify";

export const optText = (o: Element) => collapse(o.textContent ?? "");
const isRealOption = (o: HTMLElement) => {
  const t = optText(o);
  return !!t && !RE_NO_OPTIONS.test(t) && !RE_PLACEHOLDER_OPTION.test(t) && o.getAttribute("aria-disabled") !== "true";
};

export function optionElements(c: Element): HTMLElement[] {
  let els = [...c.querySelectorAll<HTMLElement>(OPTION_SELECTORS)];
  if (!els.length && c.getAttribute("role") === "listbox") els = [...c.querySelectorAll<HTMLElement>(":scope > *")];
  return els.filter((o) => isVisible(o) && isRealOption(o));
}

export interface Snapshot {
  boxes: Set<Element>;
  options: Set<Element>;
}

export const snapshot = (): Snapshot => ({
  boxes: new Set(deepQueryAll("[role=listbox]").filter(isVisible)),
  options: new Set(deepQueryAll(OPTION_SELECTORS).filter(isVisible)),
});

function controlledBy(els: (Element | undefined)[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of els) {
    for (const attr of ["aria-controls", "aria-owns"]) {
      for (const id of el?.getAttribute(attr)?.split(/\s+/) ?? []) {
        const t = id && ((el!.getRootNode() as Document).getElementById?.(id) ?? document.getElementById(id));
        if (t) out.push(t);
      }
    }
  }
  return out;
}

/** The options container that appeared for this widget (§14.5.1 step 2). */
export function findOptionsContainer(h: FieldHandle, before: Snapshot): HTMLElement | null {
  for (const c of controlledBy([h.el, h.searchInput, h.el.querySelector("[aria-controls],[aria-owns]") ?? undefined]))
    if (isVisible(c) && optionElements(c).length) return c;
  for (const lb of deepQueryAll("[role=listbox]"))
    if (lb !== h.listbox && !before.boxes.has(lb) && isVisible(lb) && optionElements(lb).length) return lb;
  const fresh = deepQueryAll(OPTION_SELECTORS).filter(
    (o) => !before.options.has(o) && !h.el.contains(o) && isVisible(o) && isRealOption(o),
  );
  const parents = new Map<Element, number>();
  for (const o of fresh) if (o.parentElement) parents.set(o.parentElement, (parents.get(o.parentElement) ?? 0) + 1);
  for (const [p, n] of parents) if (n >= 2 || fresh.length === 1) return p as HTMLElement;
  return null;
}

const triggerOf = (h: FieldHandle) =>
  h.el.matches("[role=combobox],[aria-haspopup]")
    ? h.el
    : (h.el.querySelector<HTMLElement>("[role=combobox]:not(input),[aria-haspopup]") ?? h.el);

export async function openDropdown(h: FieldHandle): Promise<HTMLElement | null> {
  if (h.listbox) return h.listbox;
  const before = snapshot();
  const t = triggerOf(h);
  realClick(t);
  let c = await waitFor(() => findOptionsContainer(h, before), 300);
  // Some sites drop a click that lands soon after another popup closed (Amazon's Select2: 250 ms); retry once.
  if (!c && t.getAttribute("aria-expanded") === "false") {
    realClick(t);
    c = await waitFor(() => findOptionsContainer(h, before), 300);
  }
  // Opened and settled with no options ("No results found" until a parent field is set): nothing more will come.
  const popups = controlledBy([t]).filter(isVisible);
  if (!c && t.getAttribute("aria-expanded") === "true" && popups.length && !busy(popups)) {
    await closeDropdown(h, popups[0]);
    return null;
  }
  if (!c) {
    const target = h.searchInput ?? t;
    focus(target);
    key(target, "ArrowDown");
    c = await waitFor(() => findOptionsContainer(h, before), 900);
  }
  return c;
}

export async function closeDropdown(h: FieldHandle, c: HTMLElement | null) {
  if (h.listbox || !c) return;
  key(h.searchInput ?? triggerOf(h), "Escape");
  await sleep(30);
  if (c.isConnected && isVisible(c)) realClick(document.body, { x: 1, y: 1 });
}

// Virtualized lists re-render from scroll events, which fire on the next rendering frame. Hidden tabs render no
// frames, so there the event is ours, fired at once, and nothing waits on frames.
function scrollTo(s: HTMLElement, top: number) {
  s.scrollTop = top;
  if (document.hidden) s.dispatchEvent(new Event("scroll"));
}
const settleScroll = () =>
  sleep(50).then(() =>
    document.hidden
      ? undefined
      : Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          sleep(100),
        ]),
  );

function scroller(c: HTMLElement): HTMLElement | null {
  for (const el of [c, ...c.querySelectorAll<HTMLElement>("*")])
    if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible") return el;
  return null;
}

// Infinite-scroll lists fetch their next page once scrolled to the very bottom: react-select-async-paginate
// (Greenhouse) checks the scroll position every 300 ms, then shows a spinner until the page arrives. A list is
// complete once it stays quiet (no growth, no spinner) this long; a harvest budget cannot cut this wait, or no
// scrollable list would ever fit in one.
const QUIET_MS = 500;
const PAGE_MAX_MS = 5000;
const BUSY = "[aria-busy=true],[class*=loading i],[class*=spinner i]";
const busy = (roots: Element[]) =>
  roots.some((r) => [r, ...r.querySelectorAll(BUSY)].some((el) => el.matches(BUSY) && isVisible(el)));

/**
 * Collect option texts, scrolling virtualized lists until nothing new appears twice and the list stays quiet at
 * the bottom. Returns null if `deadline` passes before the list is complete, or for 500+ options.
 */
export async function collectOptions(
  c: HTMLElement,
  widget: Element,
  stopAt?: (text: string) => boolean,
  deadline = Infinity,
): Promise<Map<string, HTMLElement> | null> {
  const seen = new Map<string, HTMLElement>();
  const add = () => {
    let added = 0;
    for (const o of optionElements(c)) {
      const t = optText(o);
      if (!seen.has(t)) {
        seen.set(t, o);
        added++;
      } else seen.set(t, o);
    }
    return added;
  };
  add();
  const s = scroller(c);
  if (!s || [...seen.keys()].some((t) => stopAt?.(t))) return seen;
  scrollTo(s, 0);
  await settleScroll();
  add();
  let idle = 0;
  while (seen.size < 500) {
    scrollTo(s, s.scrollTop + s.clientHeight);
    await settleScroll();
    idle = add() ? 0 : idle + 1;
    if ([...seen.keys()].some((t) => stopAt?.(t))) return seen;
    if (Date.now() > deadline) return null;
    if (idle < 2) continue;
    const end = s.scrollHeight;
    scrollTo(s, end);
    const start = Date.now();
    let quiet = start;
    while (s.scrollHeight <= end) {
      const now = Date.now();
      if (busy([c, widget])) {
        quiet = now;
        if (now > deadline || now - start > PAGE_MAX_MS) return null;
      } else if (now - quiet >= QUIET_MS) return seen;
      await sleep(50);
    }
    idle = 0;
  }
  return null;
}

/** Harvest options of a closed dropdown (§14.5.1); null if it cannot open or exceeds `budgetMs`. */
export async function harvestOptions(h: FieldHandle, budgetMs = Infinity): Promise<string[] | null> {
  const deadline = Date.now() + budgetMs;
  const c = await openDropdown(h);
  if (!c) return null;
  // A row still loading (Select2's "Loading more results…") means another page plus QUIET_MS: past a short budget.
  const loading =
    budgetMs < QUIET_MS && [...c.querySelectorAll(OPTION_SELECTORS)].some((o) => /^loading/i.test(optText(o)));
  const all = loading ? null : await collectOptions(c, h.el, undefined, deadline);
  await closeDropdown(h, c);
  const texts = all ? [...all.keys()] : [];
  return texts.length ? texts : null;
}

const shows = (h: FieldHandle, text: string) => sameValue(text, dropdownText(h), "contains");
// Some widgets display only part of the picked option: Greenhouse's phone country shows "+1" for "Canada +1".
const showsPart = (h: FieldHandle, text: string) => {
  const shown = dropdownText(h);
  return !!normalize(shown) && sameValue(shown, text, "contains");
};

async function pickOne(h: FieldHandle, text: string): Promise<boolean> {
  if (shows(h, text)) return true;
  let c = await openDropdown(h);
  if (!c) return false;
  const match = (t: string) => normalize(t) === normalize(text);
  let el = optionElements(c).find((o) => match(optText(o)));
  // Select2 keeps its search box in the popup, focused on open and tied to the list by aria-controls.
  const a = document.activeElement;
  const search = h.searchInput ?? (a && isTextInput(a) && !a.readOnly && controlledBy([a]).includes(c) ? a : undefined);
  if (!el && search) {
    focus(search);
    setNativeValue(search, "");
    await typeText(search, text, 0);
    const found = () => {
      const box = c!.isConnected ? c! : findOptionsContainer(h, { boxes: new Set(), options: new Set() });
      if (box) c = box;
      return box ? optionElements(box).find((o) => match(optText(o))) : undefined;
    };
    el = (await waitFor(found, 800)) ?? undefined;
    // Remote search (Select2 AJAX) can take over a second: keep waiting until the list's spinner goes.
    if (!el && busy([c!, h.el])) {
      await waitFor(() => found() || !busy([c!, h.el]), PAGE_MAX_MS);
      el = found();
    }
  }
  if (!el) {
    const all = await collectOptions(c, h.el, match);
    const k = all && [...all.keys()].find(match);
    el = k ? all.get(k) : undefined;
  }
  if (!el) {
    await closeDropdown(h, c);
    return false;
  }
  const index = optionElements(c).indexOf(el);
  const before = dropdownText(h);
  // A partial display that did not change ("+1" preset by the phone input) may be another +1 country:
  // the reopened list's aria-selected option says which one is picked.
  const selected = async () => {
    const box = await openDropdown(h);
    const on = !!box && optionElements(box).some((o) => match(optText(o)) && isOn(o));
    await closeDropdown(h, box);
    return on;
  };
  const took = async () => shows(h, text) || (showsPart(h, text) && (dropdownText(h) !== before || (await selected())));
  realClick(el);
  await sleep(40);
  if (await took()) return true;
  if (index < 0) return false;
  // Keyboard-driven widgets: ArrowDown to the option, then Enter.
  const t = h.searchInput ?? triggerOf(h);
  focus(t);
  for (let i = 0; i <= index; i++) key(t, "ArrowDown");
  key(t, "Enter");
  await sleep(40);
  return took();
}

export async function fillDropdown(h: FieldHandle, texts: string[]): Promise<FillResult> {
  if (h.listbox) {
    for (const text of texts) {
      const o = optionElements(h.listbox).find((x) => normalize(optText(x)) === normalize(text));
      if (!o) return { outcome: "failed", note: `Option not found: ${text}` };
      if (o.getAttribute("aria-selected") !== "true") realClick(o);
    }
    await sleep(20);
    return texts.every((t) => shows(h, t))
      ? { outcome: "ok", shown: texts.join(", ") }
      : { outcome: "mismatch", note: `Expected ${texts.join(", ")}` };
  }
  for (const text of texts) {
    if (!(await pickOne(h, text))) {
      const c = findOptionsContainer(h, { boxes: new Set(), options: new Set() });
      await closeDropdown(h, c);
      return { outcome: "failed", note: `Could not select "${text}"` };
    }
  }
  if (h.hiddenSelect) {
    const sel = h.hiddenSelect;
    dispatching(() => {
      for (const o of sel.options) if (texts.some((t) => normalize(t) === normalize(o.text))) o.selected = true;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const open = findOptionsContainer(h, { boxes: new Set(), options: new Set() });
  if (open) await closeDropdown(h, open);
  return texts.every((t) => shows(h, t) || showsPart(h, t))
    ? { outcome: "ok", shown: dropdownText(h) }
    : { outcome: "mismatch", note: `Expected ${texts.join(", ")}, shows "${dropdownText(h)}"` };
}
