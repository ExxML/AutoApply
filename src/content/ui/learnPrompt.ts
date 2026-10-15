// §16.3 "Save this answer for future applications?" card. One at a time, auto-dismiss after 12 s or on outside click.
import { clip } from "../../shared/normalize";
import { el, uiLayer } from "./root";

let current: { card: HTMLElement; timer: ReturnType<typeof setTimeout>; follow: () => void } | null = null;

export function hideLearnPrompt() {
  if (!current) return;
  clearTimeout(current.timer);
  removeEventListener("pointerdown", onOutside, true);
  removeEventListener("scroll", current.follow, true);
  removeEventListener("resize", current.follow);
  current.card.remove();
  current = null;
}

function onOutside(e: PointerEvent) {
  if (current && !e.composedPath().includes(current.card)) hideLearnPrompt();
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
  // Keep the initial (viewport-clamped) offset from the anchor and re-apply it as the page scrolls.
  const dx = Math.max(8, Math.min(r.left, innerWidth - 316)) - r.left;
  const dy = Math.min(r.bottom + 6, innerHeight - 120) - r.top;
  const follow = () => {
    const a = anchor.getBoundingClientRect();
    card.style.left = `${a.left + dx}px`;
    card.style.top = `${a.top + dy}px`;
  };
  follow();
  save.onclick = () => {
    onSave();
    hideLearnPrompt();
  };
  later.onclick = hideLearnPrompt;
  uiLayer().append(card);
  current = { card, timer: setTimeout(hideLearnPrompt, 12000), follow };
  addEventListener("pointerdown", onOutside, true);
  addEventListener("scroll", follow, { capture: true, passive: true });
  addEventListener("resize", follow, { passive: true });
}
