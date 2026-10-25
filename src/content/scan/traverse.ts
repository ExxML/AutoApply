// §11.3 DOM + shadow DOM walker. Never crosses into iframes (each frame has its own content script).
import { DROPDOWN_TRIGGER_SELECTORS } from "../../shared/constants";

export const HOST_TAG = "autoapply-root";

export const CANDIDATE_SELECTOR = [
  "input",
  "select",
  "textarea",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  "[role=combobox]",
  "[role=listbox]",
  "[role=radiogroup]",
  "[role=radio]",
  "[role=checkbox]",
  "[role=switch]",
  "[role=textbox]",
  "[aria-haspopup=listbox]",
  "button[aria-pressed]",
  DROPDOWN_TRIGGER_SELECTORS,
].join(",");

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6,legend,[role=heading]";
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "SVG",
  "IFRAME",
  "OPTION",
  HOST_TAG.toUpperCase(),
]);

export interface Collected {
  candidates: HTMLElement[];
  headings: HTMLElement[];
  buttons: HTMLButtonElement[];
  order: Map<Element, number>;
}

// Edge sends every extension API call to its browser process; probing the whole page on each waitFor tick
// floods it and stalls the page's own requests (typeahead suggestions arrive seconds late). Probe each element once.
const noShadow = new WeakSet<Element>();

export function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  // chrome.dom throws on non-HTML elements (SVG <path>, MathML); only HTML elements can host shadow roots anyway.
  if (!(el instanceof HTMLElement) || noShadow.has(el)) return null;
  const dom = typeof chrome !== "undefined" ? chrome.dom : undefined;
  const sr = typeof dom?.openOrClosedShadowRoot === "function" ? dom.openOrClosedShadowRoot(el) : null;
  // shortcut: misses a closed root attached to an element after its first probe (not-yet-upgraded custom elements
  // are re-probed), revisit if a site attaches closed roots late.
  if (!sr && el.matches(":defined")) noShadow.add(el);
  return sr;
}

export function collect(root: Element | null = document.body): Collected {
  const out: Collected = { candidates: [], headings: [], buttons: [], order: new Map() };
  let i = 0;
  const visit = (el: Element) => {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
    out.order.set(el, i++);
    const candidate = el.matches(CANDIDATE_SELECTOR);
    if (candidate) out.candidates.push(el as HTMLElement);
    // A div acting as a list's button (Jane Street's college picker) too.
    else if (el.tagName === "BUTTON" || el.matches("[role=button][aria-expanded][aria-controls]"))
      out.buttons.push(el as HTMLButtonElement);
    if (el.matches(HEADING_SELECTOR)) out.headings.push(el as HTMLElement);
    // Children of an editable region or a native select are not separate fields.
    if (candidate && (el.tagName === "SELECT" || (el as HTMLElement).isContentEditable)) return;
    const sr = shadowOf(el);
    if (sr) for (const c of Array.from(sr.children)) visit(c);
    for (const c of Array.from(el.children)) visit(c);
  };
  if (root) visit(root);
  return out;
}

/** Elements matching `selector` in the document and every reachable shadow root. */
export function deepQueryAll(selector: string, root: Document | ShadowRoot | Element = document): HTMLElement[] {
  const out: HTMLElement[] = [...root.querySelectorAll<HTMLElement>(selector)];
  for (const el of root.querySelectorAll("*")) {
    const sr = shadowOf(el);
    if (sr) out.push(...deepQueryAll(selector, sr));
  }
  return out;
}
