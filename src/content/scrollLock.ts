// Runs in the page's own (MAIN) world. Our synthetic events make page widgets call focus()/scrollIntoView()/
// scrollTo() themselves, which jerks the viewport around; while a fill runs, those calls must not scroll.
// The user's own wheel/keyboard/scrollbar scrolling never goes through these APIs, so it is untouched.
// The isolated-world content script toggles the lock with DOM events (they cross worlds).
let locked = false;
document.addEventListener("autoapply-scroll-lock", () => (locked = true));
document.addEventListener("autoapply-scroll-unlock", () => (locked = false));

const nativeFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
  nativeFocus.call(this, locked ? { ...opts, preventScroll: true } : opts);
};

function guard(target: object, name: string) {
  const t = target as Record<string, unknown>;
  const orig = t[name];
  if (typeof orig !== "function") return;
  t[name] = function (this: unknown, ...args: unknown[]) {
    if (!locked) return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
}
for (const name of ["scrollIntoView", "scrollIntoViewIfNeeded"]) guard(Element.prototype, name);
for (const name of ["scroll", "scrollTo", "scrollBy"]) guard(window, name);

export {};
