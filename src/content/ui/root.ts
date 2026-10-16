// §16: one <autoapply-root> per frame, open shadow root, own stylesheet, all: initial on the host.
import css from "./styles.css?inline";
import { HOST_TAG } from "../scan/traverse";

const layers = new Map<boolean, HTMLElement>(); // keyed by `under`
let evicted = false;
const TAKEOVER = "autoapply:takeover";

/**
 * Reloading/updating the extension orphans the running content script (its DOM and listeners survive, its
 * runtime is dead) and onInstalled injects a fresh one beside it, in another isolated world. The newest
 * instance owns the frame: it tells older ones to stand down (DOM events cross worlds) and drops their UI.
 */
export function claimFrame(onEvicted: () => void) {
  document.dispatchEvent(new Event(TAKEOVER));
  // Orphans from builds without this handshake can't hear it, so remove their layer directly.
  document.querySelectorAll(HOST_TAG).forEach((h) => h.remove());
  document.addEventListener(
    TAKEOVER,
    () => {
      evicted = true;
      layers.forEach((l) => (l.getRootNode() as ShadowRoot).host.remove());
      onEvicted();
    },
    { once: true },
  );
}

/** `under`: a layer first in tree order at z-index 1, so page popups, menus and modals paint over it. */
export function uiLayer(under = false): HTMLElement {
  if (evicted) return document.createElement("div"); // orphaned: in-flight work renders nowhere
  const cached = layers.get(under);
  if (cached?.isConnected) return cached;
  const host = document.createElement(HOST_TAG);
  host.style.cssText = `all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: ${under ? 1 : 2147483646}; pointer-events: none;`;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const layer = document.createElement("div");
  layer.className = "aa";
  shadow.append(style, layer);
  if (under) document.documentElement.prepend(host);
  else document.documentElement.append(host);
  layers.set(under, layer);
  return layer;
}

const FRAME_CLICK = "autoapply:frame-click";

/** Child frames: tell the top frame's UI about real clicks, which never cross the iframe boundary. */
export const relayClicksToTop = (signal: AbortSignal) =>
  addEventListener("pointerdown", (e) => e.isTrusted && window.top?.postMessage(FRAME_CLICK, "*"), {
    capture: true,
    signal,
  });

/**
 * Calls `fn` on a real click outside `inside` (isTrusted skips the fill engine's synthetic events). Window capture
 * runs before any page listener can stop it; clicks inside iframes never reach this window, so child frames relay.
 */
export function onOutsideClick(inside: Element, fn: () => void, signal?: AbortSignal) {
  addEventListener("pointerdown", (e) => e.isTrusted && !e.composedPath().includes(inside) && fn(), {
    capture: true,
    signal,
  });
  addEventListener("message", (e) => e.data === FRAME_CLICK && fn(), { signal });
}

const RUN = Math.random().toString(36).slice(2, 8); // keeps names unique beside an orphaned instance's leftovers
let anchors = 0;
/**
 * Ties `els` (already in a uiLayer) to `target` with CSS anchor positioning, so the compositor moves them in the
 * same frame the page scrolls; JS repositioning on scroll events always lands a frame or more behind. Anchor names
 * are tree-scoped: a position-anchor declared in our shadow tree can't see a name set on a page element, so it is
 * declared by a ::part() rule in the document tree instead. Names inside page shadow trees can't be reached from
 * outside at all: returns null for those (and without browser support), else the release function.
 */
export function anchorTo(target: Element, ...els: HTMLElement[]): (() => void) | null {
  if (evicted) return () => {};
  if (!(target instanceof HTMLElement) || target.getRootNode() !== document || !CSS.supports("anchor-name", "--a"))
    return null;
  const part = `${HOST_TAG}-${RUN}-${anchors++}`;
  const own = getComputedStyle(target).getPropertyValue("anchor-name"); // keep the page's own anchors working
  target.style.setProperty("anchor-name", own === "none" ? `--${part}` : `${own}, --${part}`);
  for (const e of els) e.part.add(part);
  // In our host's light DOM: a document-tree stylesheet that leaves with the host.
  const rule = el("style", { textContent: `${HOST_TAG}::part(${part}) { position-anchor: --${part}; }` });
  (els[0].getRootNode() as ShadowRoot).host.append(rule);
  return () => {
    rule.remove();
    const rest = target.style
      .getPropertyValue("anchor-name")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && n !== `--${part}`);
    if (rest.length) target.style.setProperty("anchor-name", rest.join(", "));
    else target.style.removeProperty("anchor-name");
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}
