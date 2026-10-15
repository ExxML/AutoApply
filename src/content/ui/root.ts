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

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}
