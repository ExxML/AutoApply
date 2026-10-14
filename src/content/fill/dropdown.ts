// §14.5 custom dropdowns: open, harvest (incl. virtualized lists), select, verify, sync hidden select.
import { OPTION_SELECTORS, RE_NO_OPTIONS, RE_PLACEHOLDER_OPTION } from "../../shared/constants";
import { collapse, normalize } from "../../shared/normalize";
import type { FieldHandle } from "../scan/fields";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { dispatching, focus, key, realClick, setNativeValue, sleep, typeText, waitFor } from "./events";
import type { FillResult } from "./native";
import { dropdownText, sameValue } from "./verify";

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
    (o) => !before.options.has(o) && !h.el.contains(o) && isVisible(o),
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

function scroller(c: HTMLElement): HTMLElement | null {
  for (const el of [c, ...c.querySelectorAll<HTMLElement>("*")])
    if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible") return el;
  return null;
}

/** Collect option texts, scrolling virtualized lists until nothing new appears twice (max 500). */
export async function collectOptions(
  c: HTMLElement,
  stopAt?: (text: string) => boolean,
): Promise<Map<string, HTMLElement>> {
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
  s.scrollTop = 0;
  await sleep(50);
  add();
  let idle = 0;
  while (idle < 2 && seen.size < 500) {
    s.scrollTop += s.clientHeight;
    await sleep(50);
    idle = add() ? 0 : idle + 1;
    if ([...seen.keys()].some((t) => stopAt?.(t))) break;
  }
  return seen;
}

/** Pre-harvest options of a closed dropdown (§14.5.1). */
export async function harvestOptions(h: FieldHandle): Promise<string[] | null> {
  const c = await openDropdown(h);
  if (!c) return null;
  const texts = [...(await collectOptions(c)).keys()];
  await closeDropdown(h, c);
  return texts.length ? texts : null;
}

const shows = (h: FieldHandle, text: string) => sameValue(text, dropdownText(h), "contains");

async function pickOne(h: FieldHandle, text: string): Promise<boolean> {
  if (shows(h, text)) return true;
  let c = await openDropdown(h);
  if (!c) return false;
  const match = (t: string) => normalize(t) === normalize(text);
  let el = optionElements(c).find((o) => match(optText(o)));
  if (!el && h.searchInput) {
    focus(h.searchInput);
    setNativeValue(h.searchInput, "");
    await typeText(h.searchInput, text, 0);
    el =
      (await waitFor(() => {
        const box = c!.isConnected ? c! : findOptionsContainer(h, { boxes: new Set(), options: new Set() });
        if (box) c = box;
        return box ? optionElements(box).find((o) => match(optText(o))) : undefined;
      }, 800)) ?? undefined;
  }
  if (!el) {
    const all = await collectOptions(c, match);
    const k = [...all.keys()].find(match);
    el = k ? all.get(k) : undefined;
  }
  if (!el) {
    await closeDropdown(h, c);
    return false;
  }
  const index = optionElements(c).indexOf(el);
  realClick(el);
  await sleep(40);
  if (!shows(h, text) && index >= 0) {
    // Keyboard-driven widgets: ArrowDown to the option, then Enter.
    const t = h.searchInput ?? triggerOf(h);
    focus(t);
    for (let i = 0; i <= index; i++) key(t, "ArrowDown");
    key(t, "Enter");
    await sleep(40);
  }
  return shows(h, text);
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
  return texts.every((t) => shows(h, t))
    ? { outcome: "ok", shown: dropdownText(h) }
    : { outcome: "mismatch", note: `Expected ${texts.join(", ")}, shows "${dropdownText(h)}"` };
}
