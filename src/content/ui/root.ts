// §16: one <autoapply-root> per frame, open shadow root, own stylesheet, all: initial on the host.
import css from "./styles.css?inline";
import { HOST_TAG } from "../scan/traverse";

let shadow: ShadowRoot | null = null;
let layer: HTMLElement | null = null;

export function uiLayer(): HTMLElement {
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
