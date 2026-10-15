// §16.2 field badges: outline box + pill tag in the shadow-root layer, repositioned via rAF.
import { el, uiLayer } from "./root";

export type BadgeColor = "green" | "blue" | "purple" | "yellow" | "orange" | "red";

interface Badge {
  target: Element;
  box: HTMLElement;
  tag: HTMLElement;
}

const badges = new Map<string, Badge>();
let visible = true;
let queued = false;
let ro: ResizeObserver | null = null;

function place(b: Badge) {
  const r = b.target.getBoundingClientRect();
  const hide = !visible || (!r.width && !r.height) || !b.target.isConnected;
  b.box.style.display = b.tag.style.display = hide ? "none" : "";
  if (hide) return;
  Object.assign(b.box.style, {
    left: `${r.left - 3}px`,
    top: `${r.top - 3}px`,
    width: `${r.width + 6}px`,
    height: `${r.height + 6}px`,
  });
  Object.assign(b.tag.style, { left: `${r.right + 3}px`, top: `${r.top - 3}px` });
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    badges.forEach(place);
  });
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  addEventListener("scroll", schedule, { capture: true, passive: true });
  addEventListener("resize", schedule, { passive: true });
  ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
}

export function setBadge(
  id: string,
  target: Element,
  color: BadgeColor,
  label: string,
  tooltip: string,
  onClick?: () => void,
  fieldLabel = "",
) {
  listen();
  let b = badges.get(id);
  if (!b) {
    b = { target, box: el("div"), tag: el("button", { type: "button" }) };
    uiLayer(true).append(b.box);
    uiLayer().append(b.tag);
    badges.set(id, b);
    ro?.observe(target);
  }
  b.box.className = `box ${color}`;
  b.tag.className = `tag ${color}`;
  b.tag.textContent = label;
  b.tag.title = tooltip;
  b.tag.dataset.fieldId = b.box.dataset.fieldId = id;
  b.tag.dataset.color = color;
  b.tag.onclick = onClick ?? null;
  b.tag.setAttribute("aria-label", `${fieldLabel}: ${label}. ${tooltip}`);
  place(b);
}

export function removeBadge(id: string) {
  const b = badges.get(id);
  if (!b) return;
  b.box.remove();
  b.tag.remove();
  ro?.unobserve(b.target);
  badges.delete(id);
}

export function setBadgesVisible(v: boolean) {
  visible = v;
  schedule();
}
