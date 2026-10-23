// §11.3 visibility rules.

export function isVisible(el: Element): boolean {
  if (!el.getClientRects().length) return false;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.visibility === "collapse" || cs.display === "none") return false;
  let opacity = 1;
  for (let n: Element | null = el; n && opacity > 0.05; n = parentOf(n)) {
    if (n.getAttribute("aria-hidden") === "true") return false;
    opacity *= Number(getComputedStyle(n).opacity || 1);
  }
  if (opacity <= 0.05) return false;
  const r = el.getBoundingClientRect();
  return !(r.right + scrollX < -1000 || r.bottom + scrollY < -1000);
}

/** Parent element, crossing shadow-root boundaries. */
export function parentOf(n: Element): Element | null {
  if (n.parentElement) return n.parentElement;
  const root = n.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** `a` contains `n`, crossing shadow-root boundaries. */
export function composedContains(a: Element, n: Element): boolean {
  for (let x: Element | null = n; x; x = parentOf(x)) if (x === a) return true;
  return false;
}
