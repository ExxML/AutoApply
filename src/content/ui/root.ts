// §16: one <autoapply-root> per frame, open shadow root, own stylesheet, all: initial on the host.
import css from "./styles.css?inline";
import { HOST_TAG } from "../scan/traverse";

let shadow: ShadowRoot | null = null;
let layer: HTMLElement | null = null;
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
      shadow?.host.remove();
      onEvicted();
    },
    { once: true },
  );
}

export function uiLayer(): HTMLElement {
  if (evicted) return document.createElement("div"); // orphaned: in-flight work renders nowhere
  if (layer && shadow?.host.isConnected) return layer;
  const host = document.createElement(HOST_TAG);
  host.style.cssText =
    "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none;";
  shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  layer = document.createElement("div");
  layer.className = "aa";
  shadow.append(style, layer);
  document.documentElement.append(host);
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
