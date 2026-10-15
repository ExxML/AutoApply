// §11.4 FieldDescriptor extraction. Element references stay in the content script (FieldHandle).
import {
  RE_CONSENT,
  RE_COOKIE_CONTAINER,
  RE_NEWSLETTER,
  RE_PLACEHOLDER_OPTION,
  RE_SENSITIVE_LABEL,
  RE_SKIP_LABEL,
} from "../../shared/constants";
import { clip, collapse, humanize } from "../../shared/normalize";
import type { FieldDescriptor } from "../../shared/types";
import { readValue } from "../fill/verify";
import { buildUnits, memberText, type Unit } from "./groups";
import {
  controlLabel,
  fallbackLabel,
  finishLabel,
  groupLabel,
  hintFor,
  labelElementFor,
  precedingText,
  sectionFor,
} from "./labels";
import { collect, type Collected } from "./traverse";
import { parentOf } from "./visibility";
import { findHiddenSelect, isTypeaheadInput, nativeOptions } from "./widgets";

export interface FieldHandle {
  id: string;
  desc: FieldDescriptor;
  el: HTMLElement;
  members?: HTMLElement[];
  buttonStyle?: boolean;
  /** Native <option>s (select) or [role=option]s (inline listbox), aligned with desc.options. */
  optionEls?: HTMLElement[];
  searchInput?: HTMLInputElement;
  listbox?: HTMLElement;
  hiddenSelect?: HTMLSelectElement;
  container: HTMLElement;
  prefilled: boolean;
  sensitive: boolean;
  consent: boolean;
}

export interface ScanState {
  ids: WeakMap<Element, string>;
  next: number;
}

export const newScanState = (): ScanState => ({ ids: new WeakMap(), next: 1 });

function lowestCommonAncestor(els: Element[]): Element {
  let a: Element | null = els[0].parentElement ?? els[0];
  while (a && !els.every((e) => a!.contains(e))) a = parentOf(a);
  return a ?? els[0];
}

/** Climb ≤4 ancestors while the ancestor still contains no other field (§11.5 step 5). */
function containerFor(unit: Unit, owner: Map<Element, Set<Unit>>): HTMLElement {
  let cur: Element = unit.members && unit.members.length > 1 ? lowestCommonAncestor(unit.members) : unit.el;
  for (let i = 0; i < 4; i++) {
    const p = parentOf(cur);
    if (!p || p === document.body || p.tagName === "FORM" || p.tagName === "HTML") break;
    const owners = owner.get(p);
    if (owners && (owners.size > 1 || !owners.has(unit))) break;
    cur = p;
  }
  return cur as HTMLElement;
}

function buildOwnerMap(units: Unit[]): Map<Element, Set<Unit>> {
  const m = new Map<Element, Set<Unit>>();
  for (const u of units)
    for (const el of u.members ?? [u.el]) {
      let n: Element | null = el;
      for (let i = 0; i < 8 && n; i++, n = parentOf(n)) {
        let s = m.get(n);
        if (!s) m.set(n, (s = new Set()));
        s.add(u);
      }
    }
  return m;
}

const isDisabled = (el: Element) =>
  (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true";

function excludedContext(el: HTMLElement, label: string, mainForm: HTMLFormElement | null): boolean {
  if (el.closest("nav,[role=navigation],[role=search]")) return true;
  const form = el.closest("form");
  if (el.closest("header") && !form) return true;
  if (!form) {
    for (let n: Element | null = el; n; n = parentOf(n)) {
      const idc = `${n.id} ${typeof n.className === "string" ? n.className : ""}`;
      if (RE_COOKIE_CONTAINER.test(idc)) return true;
    }
  }
  return RE_NEWSLETTER.test(label) && (!form || (mainForm !== null && form !== mainForm));
}

export interface ScanResult {
  handles: FieldHandle[];
  collected: Collected;
}

export function scan(state: ScanState, root: Element | null = document.body): ScanResult {
  const collected = collect(root);
  const units = buildUnits(collected);
  const owner = buildOwnerMap(units);
  const forms = new Map<HTMLFormElement, number>();
  for (const u of units) {
    const f = u.el.closest("form");
    if (f) forms.set(f, (forms.get(f) ?? 0) + 1);
  }
  const mainForm = [...forms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const handles: FieldHandle[] = [];
  for (const u of units) {
    const el = u.el;
    const members = u.members;
    if (members ? members.every(isDisabled) : isDisabled(el)) continue;
    if (u.groupEl && isDisabled(u.groupEl)) continue;
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly && u.kind !== "dropdown")
      continue;

    const container = containerFor(u, owner);
    const isGroup = u.kind === "radio_group" || u.kind === "checkbox_group";
    const memberLabels = (members ?? [])
      .map((m) => (m instanceof HTMLInputElement ? labelElementFor(m) : m))
      .filter((x): x is HTMLElement => !!x);
    const rawLabel =
      (isGroup
        ? groupLabel(u.groupEl ?? null) || precedingText(container, members![0], memberLabels)
        : controlLabel(el) ||
          (u.searchInput ? controlLabel(u.searchInput) : "") ||
          precedingText(container, el, memberLabels)) || fallbackLabel(u.searchInput ?? el);
    const label = finishLabel(rawLabel);
    const nameId = `${el.getAttribute("name") ?? ""} ${el.id}`;
    if (RE_SKIP_LABEL.test(label) || RE_SKIP_LABEL.test(nameId)) continue;
    if (excludedContext(el, label, mainForm)) continue;

    let kind = u.kind;
    if (kind === "text" && el instanceof HTMLInputElement && isTypeaheadInput(el, label)) kind = "typeahead";

    const h: FieldHandle = {
      id: "",
      desc: { id: "", kind, label, required: false, optionsKnown: true },
      el,
      members,
      buttonStyle: u.buttonStyle,
      searchInput: u.searchInput,
      listbox: u.listbox,
      container,
      prefilled: false,
      sensitive: false,
      consent: false,
    };
    const d = h.desc;

    // Options
    if (el instanceof HTMLSelectElement) {
      const o = nativeOptions(el);
      if (o) {
        d.options = o.texts;
        h.optionEls = o.els;
      } else d.optionsKnown = false;
      if (el.multiple) d.multiple = true;
    } else if (members) {
      d.options = members.map((m) => clip(collapse(memberText(m)), 200));
      if (kind === "checkbox_group") d.multiple = true;
    } else if (kind === "dropdown") {
      const hidden = findHiddenSelect(container);
      if (u.listbox) {
        h.optionEls = [...u.listbox.querySelectorAll<HTMLElement>("[role=option]")];
        d.options = h.optionEls.map((o) => collapse(o.textContent ?? ""));
        if (u.listbox.getAttribute("aria-multiselectable") === "true") d.multiple = true;
      } else if (hidden && nativeOptions(hidden)) {
        h.hiddenSelect = hidden;
        d.options = nativeOptions(hidden)!.texts;
        if (hidden.multiple) d.multiple = true;
      } else {
        d.optionsKnown = false;
        if (el.getAttribute("aria-multiselectable") === "true") d.multiple = true;
      }
    } else if (kind === "typeahead") d.optionsKnown = false;
    if (d.options && d.options.length > 300) {
      delete d.options;
      d.optionsKnown = false;
    }

    // Descriptor details
    const hint = hintFor(u.searchInput ?? el, container);
    if (hint && hint !== label) d.hint = hint;
    const section = sectionFor(el, collected.order, collected.headings);
    if (section && section !== label) d.section = section;
    const required =
      [el, u.searchInput, u.groupEl, ...(members ?? [])].some(
        (n) => n && ((n as HTMLInputElement).required || n.getAttribute("aria-required") === "true"),
      ) || /\*|\(required\)/i.test(rawLabel);
    d.required = !!required;
    const input = (u.searchInput ?? el) as HTMLInputElement;
    const ph = input.getAttribute?.("placeholder");
    if (ph) d.placeholder = clip(ph, 120);
    if (el instanceof HTMLInputElement) d.inputType = el.type;
    const ac = input.getAttribute?.("autocomplete");
    if (ac && ac !== "on" && ac !== "off") d.autocomplete = ac;
    const nm = el.getAttribute("name") || el.id;
    if (nm) d.nameAttr = clip(humanize(nm), 80);
    if (
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
      el.maxLength > 0 &&
      el.maxLength < 100000
    )
      d.maxLength = el.maxLength;
    if (el instanceof HTMLInputElement && el.type === "file" && el.accept) d.accept = el.accept;

    h.sensitive = /^cc-/.test((d.autocomplete ?? "").split(/\s+/).pop() ?? "") || RE_SENSITIVE_LABEL.test(label);
    h.consent = kind === "checkbox" && RE_CONSENT.test(label);

    const current = readValue(h);
    if (current) d.currentValue = clip(current, 300);
    h.prefilled = isPrefilled(h, current);

    let id = state.ids.get(el);
    if (!id) state.ids.set(el, (id = `f${state.next++}`));
    h.id = d.id = id;
    handles.push(h);
  }
  return { handles, collected };
}

function isPrefilled(h: FieldHandle, current: string): boolean {
  if (!current) return false;
  const k = h.desc.kind;
  if (k === "dropdown") return !RE_PLACEHOLDER_OPTION.test(current) && !/^(select|choose)/i.test(current);
  if (k === "checkbox") return current === "true";
  if (h.desc.placeholder && current === h.desc.placeholder) return false;
  return true;
}
