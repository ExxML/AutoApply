// §16.3 "Save this answer for future applications?" card. One at a time, auto-dismiss after 12 s or on outside click.
import { clip } from "../../shared/normalize";
import { anchorTo, el, onOutsideClick, uiLayer } from "./root";

let current: {
  card: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  listeners: AbortController;
  release: (() => void) | null;
} | null = null;

export function hideLearnPrompt() {
  if (!current) return;
  clearTimeout(current.timer);
  current.listeners.abort();
  current.release?.();
  current.card.remove();
  current = null;
}

export function showLearnPrompt(anchor: Element, label: string, answer: string, onSave: () => void, title?: string) {
  hideLearnPrompt();
  const r = anchor.getBoundingClientRect();
  const save = el("button", { className: "btn primary", type: "button", textContent: "Save" });
  const later = el("button", { className: "btn", type: "button", textContent: "Not now" });
  const card = el(
    "div",
    { className: "learn" },
    el("div", { className: "status", textContent: title ?? "Save this answer for future applications?" }),
    el("div", { className: "qa", textContent: `"${clip(label, 80)}" → "${clip(answer, 120)}"` }),
    el("div", { className: "actions" }, save, later),
  );
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Save answer");
  // Keep the initial (viewport-clamped) offset from the anchor as the page scrolls: in CSS when the anchor can be
  // CSS-anchored, else re-applied on scroll.
  const dx = Math.max(8, Math.min(r.left, innerWidth - 316)) - r.left;
  const dy = Math.min(r.bottom + 6, innerHeight - 120) - r.top;
  uiLayer().append(card);
  const release = anchorTo(anchor, card);
  const follow = () => {
    const a = anchor.getBoundingClientRect();
    card.style.left = `${a.left + dx}px`;
    card.style.top = `${a.top + dy}px`;
  };
  if (release) {
    card.style.left = `calc(anchor(left) + ${dx}px)`;
    card.style.top = `calc(anchor(top) + ${dy}px)`;
  } else follow();
  save.onclick = () => {
    onSave();
    hideLearnPrompt();
  };
  later.onclick = hideLearnPrompt;
  const listeners = new AbortController();
  const { signal } = listeners;
  current = { card, timer: setTimeout(hideLearnPrompt, 12000), listeners, release };
  onOutsideClick(card, hideLearnPrompt, signal);
  if (release) return;
  addEventListener("scroll", follow, { capture: true, passive: true, signal });
  addEventListener("resize", follow, { passive: true, signal });
}
