// §14.1 event helpers. Every DOM write goes through here with `fillingNow` set, so our own
// synthetic events are never mistaken for user input.
import { RE_FORBIDDEN_CLICK } from "../../shared/constants";
import { send } from "../../shared/messages";
import { collapse } from "../../shared/normalize";

let fillingNow = false;
export const isFilling = () => fillingNow;

export function dispatching<T>(fn: () => T): T {
  const prev = fillingNow;
  fillingNow = true;
  try {
    return fn();
  } finally {
    fillingNow = prev;
  }
}

const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// A hidden tab's timers wake at most once a second, so after a tab switch a fill would crawl. The service worker's
// timers are not throttled, and its reply reaches the hidden tab at once.
export const sleep = (ms: number): Promise<void> =>
  document.hidden
    ? send({ type: "SLEEP", ms }).then(
        () => undefined,
        () => timeout(ms),
      )
    : timeout(ms);

let scrollHolds = 0;
/** Stops the page's own scripts from scrolling while fn runs (see scrollLock.ts). */
export async function holdScroll<T>(fn: () => Promise<T>): Promise<T> {
  if (scrollHolds++ === 0) document.dispatchEvent(new Event("autoapply-scroll-lock"));
  try {
    return await fn();
  } finally {
    // widgets often scroll a frame or two after our last event (React effects, menu positioning)
    void sleep(300).then(() => {
      if (--scrollHolds === 0) document.dispatchEvent(new Event("autoapply-scroll-unlock"));
    });
  }
}

/** Resolves with fn()'s first truthy result, re-checking on DOM mutations and animation frames. */
export function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const first = fn();
    if (first) return resolve(first);
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      mo.disconnect();
      resolve(v);
    };
    const check = () => {
      const v = fn();
      if (v) finish(v);
    };
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    // Hidden tabs get no animation frames: the observer alone watches there.
    const tick = () => {
      if (done) return;
      check();
      if (!document.hidden) requestAnimationFrame(tick);
    };
    if (!document.hidden) requestAnimationFrame(tick);
    void sleep(timeoutMs).then(() => finish(fn() || null));
  });
}

/** §18.1: never click submit/next/continue/apply/save/sign-in buttons or navigating links. */
export function isForbiddenClick(el: Element): boolean {
  const b = el.closest<HTMLElement>("button,a,input[type=submit],input[type=image],[role=button],[role=link]");
  if (!b) return false;
  if (b instanceof HTMLInputElement) return true;
  // Toggles (aria-pressed: Ashby's Yes/No pills) and popup openers submit nothing, whatever their type says.
  if (
    b instanceof HTMLButtonElement &&
    b.type === "submit" &&
    !b.hasAttribute("aria-haspopup") &&
    !b.hasAttribute("aria-expanded") &&
    !b.hasAttribute("aria-pressed")
  )
    return true;
  if (b instanceof HTMLAnchorElement) {
    const href = b.getAttribute("href");
    if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) return true;
  }
  return (
    RE_FORBIDDEN_CLICK.test(collapse(b.textContent ?? "")) ||
    RE_FORBIDDEN_CLICK.test(b.getAttribute("aria-label") ?? "")
  );
}

export function realClick(el: HTMLElement, at?: { x: number; y: number }) {
  if (el !== document.body && isForbiddenClick(el)) throw new Error("Refusing to click a submit/navigation control");
  const r = el.getBoundingClientRect();
  const clientX = at?.x ?? r.left + r.width / 2;
  const clientY = at?.y ?? r.top + r.height / 2;
  const base = { bubbles: true, composed: true, cancelable: true, clientX, clientY, button: 0, view: window };
  const p = (type: string) => new PointerEvent(type, { ...base, pointerType: "mouse", isPrimary: true, pointerId: 1 });
  const m = (type: string) => new MouseEvent(type, base);
  dispatching(() => {
    el.dispatchEvent(p("pointerover"));
    el.dispatchEvent(p("pointerenter"));
    el.dispatchEvent(m("mouseover"));
    el.dispatchEvent(p("pointerdown"));
    el.dispatchEvent(m("mousedown"));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(p("pointerup"));
    el.dispatchEvent(m("mouseup"));
    el.dispatchEvent(m("click"));
  });
}

type Valued = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function setNativeValue(el: Valued, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const desc =
    Object.getOwnPropertyDescriptor(proto, "value") ??
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype,
      "value",
    );
  dispatching(() => {
    desc?.set?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function focus(el: HTMLElement) {
  dispatching(() => {
    el.focus({ preventScroll: true });
    // A page without focus (background tab) moves activeElement but fires no focus events.
    if (!document.hasFocus()) el.dispatchEvent(new FocusEvent("focus"));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
  });
}

export function blur(el: HTMLElement) {
  dispatching(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    el.dispatchEvent(new FocusEvent("blur"));
    el.blur();
  });
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, ArrowDown: 40 };

export function key(el: HTMLElement, k: string, type: "keydown" | "keyup" | "both" = "both") {
  // jQuery-era widgets (Select2) read the legacy keyCode/which and ignore keys without them.
  const keyCode = KEY_CODES[k];
  const init = { key: k, code: k, keyCode, which: keyCode, bubbles: true, composed: true, cancelable: true };
  dispatching(() => {
    if (type !== "keyup") el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (type !== "keydown") el.dispatchEvent(new KeyboardEvent("keyup", init));
  });
}

/** Per-character typing for masked inputs and typeaheads. */
export async function typeText(el: HTMLInputElement | HTMLTextAreaElement, text: string, delayMs = 15) {
  let prefix = el.value;
  for (const ch of text) {
    dispatching(() => {
      const init = { key: ch, bubbles: true, composed: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data: ch }),
      );
    });
    prefix += ch;
    const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value");
    dispatching(() => {
      proto?.set?.call(el, prefix);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, composed: true }));
    });
    if (delayMs) await sleep(delayMs);
  }
}
