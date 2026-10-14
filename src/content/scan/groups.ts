// §11.5 grouping: radios, checkboxes, button-style choice groups, custom widgets → one Unit per question.
import { RE_NAV_BUTTON } from "../../shared/constants";
import type { FieldKind } from "../../shared/types";
import { labelElementFor, precedingText, textOf } from "./labels";
import type { Collected } from "./traverse";
import { isVisible, parentOf } from "./visibility";
import { isDropdownTrigger, isTextInput, wrapsSingleControl } from "./widgets";

export interface Unit {
  kind: FieldKind;
  /** Anchor element: the control, the dropdown trigger, or the first group member. */
  el: HTMLElement;
  members?: HTMLElement[];
  groupEl?: Element | null;
  buttonStyle?: boolean;
  searchInput?: HTMLInputElement;
  listbox?: HTMLElement;
}

const INPUT_KIND: Record<string, FieldKind | null> = {
  text: "text",
  "": "text",
  email: "email",
  tel: "tel",
  url: "url",
  number: "number",
  date: "date",
  month: "month",
  "datetime-local": "text",
  week: "text",
  time: "text",
  file: "file",
  search: null,
  password: null,
  hidden: null,
  submit: null,
  button: null,
  reset: null,
  image: null,
  range: null,
  color: null,
};

/** Text of a choice member (radio/checkbox input, role=radio element or button). */
export function memberText(m: HTMLElement): string {
  if (m instanceof HTMLInputElement) {
    const l = labelElementFor(m);
    const t = (l && textOf(l)) || m.getAttribute("aria-label") || "";
    if (t) return t;
    const next = m.nextSibling?.textContent?.trim();
    return next || m.value;
  }
  return m.getAttribute("aria-label") || textOf(m, "input,select,textarea,script,style");
}

const choiceVisible = (m: HTMLElement) => {
  if (isVisible(m)) return true;
  const l = m instanceof HTMLInputElement ? labelElementFor(m) : null;
  return !!l && isVisible(l);
};

function groupBy<T>(items: T[], key: (t: T) => unknown): T[][] {
  const m = new Map<unknown, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return [...m.values()];
}

const scopeOf = (el: HTMLElement) => (el as HTMLInputElement).form ?? el.getRootNode();

export function isQuestionContainer(parent: Element, first: Element): boolean {
  if (parent.getAttribute("aria-label") || parent.getAttribute("aria-labelledby")) return true;
  let c: Element | null = parent;
  for (let i = 0; i < 3 && c; i++, c = parentOf(c)) {
    const t = precedingText(c, first);
    if (t) return /\?\s*\*?$/.test(t);
  }
  return false;
}

export function buildUnits(c: Collected): Unit[] {
  const units: Unit[] = [];
  const taken = new Set<Element>();
  const take = (u: Unit) => {
    units.push(u);
    taken.add(u.el);
    u.members?.forEach((m) => taken.add(m));
  };
  const cands = c.candidates;

  // 1. Custom dropdown triggers: outermost wins; an inner editable input becomes its search box.
  const triggers: HTMLElement[] = [];
  for (const el of cands) {
    if (!isDropdownTrigger(el) || !wrapsSingleControl(el) || !isVisible(el)) continue;
    if (triggers.some((t) => t.contains(el))) continue;
    if (el.getAttribute("role") === "radiogroup") continue;
    triggers.push(el);
  }
  for (const t of triggers) {
    const inner = t.querySelector<HTMLInputElement>("input:not([type=hidden])");
    take({ kind: "dropdown", el: t, searchInput: inner && !inner.readOnly ? inner : undefined });
    cands.filter((x) => t.contains(x)).forEach((x) => taken.add(x));
  }
  // A button[aria-expanded][aria-controls] under a question label also opens a list (Appendix C.3).
  for (const b of c.buttons) {
    if (taken.has(b) || !b.hasAttribute("aria-expanded") || !b.hasAttribute("aria-controls") || !isVisible(b)) continue;
    if (RE_NAV_BUTTON.test(textOf(b)) || !b.parentElement || !isQuestionContainer(b.parentElement, b)) continue;
    take({ kind: "dropdown", el: b });
  }

  // 2. Native radios grouped by name within the same form/root, else by radiogroup/fieldset.
  const radios = cands.filter((e): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === "radio");
  const freeRadios = radios.filter((r) => !taken.has(r));
  const radioGroups = [
    ...groupBy(
      freeRadios.filter((r) => r.name),
      scopeOf,
    ).flatMap((g) => groupBy(g, (r) => r.name)),
    ...groupBy(
      freeRadios.filter((r) => !r.name),
      (r) => r.closest("[role=radiogroup],fieldset") ?? r.parentElement,
    ),
  ];
  for (const members of radioGroups) {
    if (members.some(choiceVisible))
      take({ kind: "radio_group", el: members[0], members, groupEl: members[0].closest("[role=radiogroup],fieldset") });
  }

  // 3. Native checkboxes: shared name, or a fieldset/[role=group] whose boxes share (or lack) a name.
  const boxes = cands.filter(
    (e): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === "checkbox" && !taken.has(e),
  );
  const named = groupBy(
    boxes.filter((b) => b.name),
    (b) => b.name,
  ).flatMap((g) => groupBy(g, scopeOf));
  for (const g of named.filter((g) => g.length >= 2)) {
    if (g.some(choiceVisible))
      take({ kind: "checkbox_group", el: g[0], members: g, groupEl: g[0].closest("fieldset,[role=group]") });
  }
  const rest = boxes.filter((b) => !taken.has(b));
  for (const g of groupBy(rest, (b) => b.closest("fieldset,[role=group]") ?? b)) {
    const sameName = new Set(g.map((b) => b.name)).size === 1;
    if (g.length >= 2 && sameName && g[0].closest("fieldset,[role=group]")) {
      if (g.some(choiceVisible))
        take({ kind: "checkbox_group", el: g[0], members: g, groupEl: g[0].closest("fieldset,[role=group]") });
    } else for (const b of g) if (choiceVisible(b)) take({ kind: "checkbox", el: b });
  }

  // 4. ARIA radiogroups and button-style groups.
  for (const rg of cands.filter((e) => e.getAttribute("role") === "radiogroup" && !taken.has(e))) {
    if (rg.querySelector("input[type=radio]")) continue;
    const members = [...rg.querySelectorAll<HTMLElement>("[role=radio],button[aria-pressed],[aria-checked]")];
    if (members.length && isVisible(rg))
      take({ kind: "radio_group", el: members[0], members, groupEl: rg, buttonStyle: true });
  }
  const looseChoices = cands.filter(
    (e) => !taken.has(e) && (e.getAttribute("role") === "radio" || e.matches("button[aria-pressed]")),
  );
  for (const members of groupBy(looseChoices, (e) => e.parentElement)) {
    if (members.length < 2 || !members.some(isVisible)) continue;
    take({ kind: "radio_group", el: members[0], members, groupEl: members[0].parentElement, buttonStyle: true });
  }
  // 2–8 plain sibling buttons under a question ("Yes" / "No" pills).
  for (const members of groupBy(
    c.buttons.filter((b) => !taken.has(b)),
    (b) => b.parentElement,
  )) {
    if (members.length < 2 || members.length > 8 || !members[0].parentElement) continue;
    const ok = members.every((b) => {
      const t = textOf(b);
      const submitting = b.form && b.getAttribute("type") !== "button";
      return (
        !submitting &&
        t &&
        t.length <= 40 &&
        !RE_NAV_BUTTON.test(t) &&
        !b.hasAttribute("aria-expanded") &&
        !b.hasAttribute("aria-haspopup") &&
        isVisible(b)
      );
    });
    if (ok && isQuestionContainer(members[0].parentElement, members[0]))
      take({ kind: "radio_group", el: members[0], members, groupEl: members[0].parentElement, buttonStyle: true });
  }

  // 5. Everything else, one unit per control.
  for (const el of cands) {
    if (taken.has(el)) continue;
    const role = el.getAttribute("role");
    if (el instanceof HTMLInputElement) {
      if (el.type === "radio" || el.type === "checkbox") continue;
      const kind = INPUT_KIND[el.type] ?? (el.type in INPUT_KIND ? null : "text");
      if (!kind) continue;
      if (kind !== "file" && !isVisible(el)) continue;
      take({ kind: role === "combobox" && isTextInput(el) ? "typeahead" : kind, el });
    } else if (el instanceof HTMLSelectElement) {
      if (isVisible(el)) take({ kind: el.multiple ? "multiselect" : "select", el });
    } else if (el instanceof HTMLTextAreaElement) {
      if (isVisible(el)) take({ kind: "textarea", el });
    } else if (role === "checkbox" || role === "switch") {
      if (isVisible(el)) take({ kind: "checkbox", el });
    } else if (role === "listbox") {
      if (isVisible(el) && el.querySelector("[role=option]")) take({ kind: "dropdown", el, listbox: el });
    } else if (el.isContentEditable || role === "textbox") {
      if (isVisible(el)) take({ kind: "contenteditable", el });
    }
  }

  return units.sort((a, b) => (c.order.get(a.el) ?? 0) - (c.order.get(b.el) ?? 0));
}
