// §14.9 read-back and verification.
import { alnum, collapse, digitsOnly, normalize } from "../../shared/normalize";
import { isPlaceholderOption } from "../scan/widgets";
import type { FieldHandle } from "../scan/fields";

export type VerifyOutcome = "ok" | "mismatch" | "failed";

export const isOn = (el: Element): boolean =>
  (el as HTMLInputElement).checked === true ||
  ["aria-checked", "aria-pressed", "aria-selected"].some((a) => el.getAttribute(a) === "true");

/** Text as rendered: <slot>s show their assigned nodes. */
function slottedText(n: Node): string {
  if (n instanceof HTMLSlotElement) return n.assignedNodes({ flatten: true }).map(slottedText).join("");
  if (n instanceof Element) return [...n.childNodes].map(slottedText).join("");
  return n.nodeType === Node.TEXT_NODE ? (n.textContent ?? "") : "";
}

/** Visible text of a custom dropdown, ignoring placeholder elements and the search box. */
export function dropdownText(h: FieldHandle): string {
  if (h.listbox)
    return [...h.listbox.querySelectorAll("[role=option][aria-selected=true]")]
      .map((o) => collapse(o.textContent ?? ""))
      .join(" | ");
  const clone = h.el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input,select,[class*="placeholder" i],script,style').forEach((n) => n.remove());
  // Screen-reader descriptions are not the value: Workday's empty prompt describes itself as "0 items selected".
  for (const id of [h.el, h.searchInput].flatMap((n) => n?.getAttribute("aria-describedby")?.split(/\s+/) ?? []))
    if (id) clone.querySelector(`#${CSS.escape(id)}`)?.remove();
  // A trigger inside a shadow root shows its value through a <slot> (SmartRecruiters' phone country: "+1").
  const text = collapse(clone.textContent ?? "") || (h.el.querySelector("slot") ? collapse(slottedText(h.el)) : "");
  if (text) return text;
  if (h.hiddenSelect && h.hiddenSelect.selectedIndex >= 0) {
    const o = h.hiddenSelect.options[h.hiddenSelect.selectedIndex];
    if (!isPlaceholderOption(o, h.hiddenSelect.selectedIndex)) return collapse(o.text);
  }
  // A read-only input opening the list (Workable) shows the pick as its own value.
  return (h.searchInput ?? (h.el instanceof HTMLInputElement ? h.el : undefined))?.value ?? "";
}

export function readValue(h: FieldHandle): string {
  const el = h.el;
  switch (h.desc.kind) {
    case "select":
    case "multiselect": {
      const s = el as HTMLSelectElement;
      return Array.from(s.options)
        .filter((o, i) => o.selected && !isPlaceholderOption(o, i))
        .map((o) => collapse(o.text))
        .join(" | ");
    }
    case "radio_group":
    case "checkbox_group":
      return (h.members ?? [])
        .map((m, i) => (isOn(m) ? h.desc.options?.[i] : ""))
        .filter(Boolean)
        .join(" | ");
    case "checkbox":
      return isOn(el) ? "true" : "";
    case "dropdown":
      return dropdownText(h);
    case "contenteditable":
      return collapse(el.innerText ?? el.textContent ?? "");
    case "file":
      return (el as HTMLInputElement).files?.[0]?.name ?? "";
    default:
      return (el as HTMLInputElement).value ?? "";
  }
}

/** Compare normalized; phone and masked fields by digits/alphanumerics only. */
export function sameValue(expected: string, actual: string, mode: "text" | "digits" | "alnum" | "contains" = "text") {
  if (mode === "digits") return digitsOnly(expected) === digitsOnly(actual) && digitsOnly(expected) !== "";
  if (mode === "alnum") return alnum(expected) === alnum(actual);
  if (mode === "contains") return normalize(actual).includes(normalize(expected));
  return normalize(expected) === normalize(actual);
}
