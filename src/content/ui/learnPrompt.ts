// §16.3 "Save this answer for future applications?" card. One at a time, auto-dismiss after 12 s or on outside click.
import { clip } from "../../shared/normalize";
import { el, uiLayer } from "./root";

let current: { card: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

export function hideLearnPrompt() {
  if (!current) return;
  clearTimeout(current.timer);
  removeEventListener("pointerdown", onOutside, true);
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
  card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 316))}px`;
  card.style.top = `${Math.min(r.bottom + 6, innerHeight - 120)}px`;
  save.onclick = () => {
    onSave();
    hideLearnPrompt();
  };
  later.onclick = hideLearnPrompt;
  uiLayer().append(card);
  current = { card, timer: setTimeout(hideLearnPrompt, 12000) };
  addEventListener("pointerdown", onOutside, true);
}
