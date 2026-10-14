// Records every synthetic (untrusted) click on a navigation/submit control and every form submission,
// so tests can assert the extension never clicks Submit / Next / Continue / Apply.
window.__forbidden = [];
document.addEventListener(
  "click",
  (e) => {
    const b = e.target.closest && e.target.closest("button,a,input[type=submit]");
    if (!b || e.isTrusted) return;
    const text = (b.textContent || b.value || "").trim();
    if (/submit|next|continue|apply|save/i.test(text) || b.type === "submit") window.__forbidden.push(text);
  },
  true,
);
document.addEventListener(
  "submit",
  (e) => {
    e.preventDefault();
    window.__forbidden.push("submit-event");
  },
  true,
);
