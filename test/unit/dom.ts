// happy-dom has no layout engine: give displayed elements a non-empty box so visibility checks work.
function displayed(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host || null)) {
    if (n.hasAttribute("hidden")) return false;
    const s = (n as HTMLElement).style;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    if (n.getAttribute("aria-hidden") === "true") return false;
  }
  return true;
}

export function stubLayout() {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.getClientRects = function (this: Element) {
    return displayed(this) ? [{ x: 0, y: 0, width: 100, height: 20 }] : [];
  };
  proto.getBoundingClientRect = function (this: Element) {
    const w = displayed(this) ? 100 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: w ? 20 : 0, width: w, height: w ? 20 : 0 };
  };
  proto.checkVisibility = function (this: Element) {
    return displayed(this);
  };
}

export function setBody(html: string) {
  document.body.innerHTML = html;
}
