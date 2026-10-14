// "Autofill this page" pill for the maybe-band detection score.
import { el, uiLayer } from "./root";

let pill: HTMLButtonElement | null = null;

export function showPill(onClick: () => void) {
  if (pill?.isConnected) return;
  pill = el("button", { className: "pill", type: "button", textContent: "Autofill this page" });
  pill.onclick = () => {
    hidePill();
    onClick();
  };
  uiLayer().append(pill);
}

export function hidePill() {
  pill?.remove();
  pill = null;
}
