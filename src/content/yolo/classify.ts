// What a YOLO run's page shows, for the background to tell what kind of step it is (background/yolo/classify.ts).
import type { PageFacts } from "../../shared/messages";
import { collapse } from "../../shared/normalize";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { alertText, findApply, findNext, findSubmit } from "./nav";

/** ATS forms embedded in a company page: the run loads them on their own. */
const RE_EMBED =
  /greenhouse\.io\/embed|boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|icims\.com|workable\.com/;

export const pageText = () => (document.body?.innerText ?? "").slice(0, 20000);

export function visiblePasswords(): HTMLInputElement[] {
  return deepQueryAll("input[type=password]").filter(isVisible) as HTMLInputElement[];
}

export function codeInput(): HTMLInputElement | null {
  return (
    (deepQueryAll("input").find(
      (i) =>
        isVisible(i) &&
        ((i as HTMLInputElement).autocomplete === "one-time-code" ||
          /code|otp|pin|token|verif/i.test(
            `${i.id} ${(i as HTMLInputElement).name} ${i.getAttribute("aria-label") ?? ""} ${(i as HTMLInputElement).placeholder}`,
          )),
    ) as HTMLInputElement | undefined) ?? null
  );
}

/** A challenge someone must solve: a visible image/checkbox frame, never the invisible score badge or one solved. */
function challenge(): HTMLIFrameElement | undefined {
  // A solved widget stays on the page; its response token says it's done.
  const tokens = deepQueryAll(
    '[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]',
  );
  if (tokens.some((t) => (t as HTMLTextAreaElement).value)) return undefined;
  return (deepQueryAll("iframe") as HTMLIFrameElement[]).find((f) => {
    const shown =
      /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*frame=challenge|challenges\.cloudflare\.com/.test(f.src) ||
      (/recaptcha\/(api2|enterprise)\/anchor|hcaptcha\.com.*frame=checkbox/.test(f.src) &&
        !/size=invisible/.test(f.src));
    const r = f.getBoundingClientRect();
    // hCaptcha shows its challenge in a page-sized "enclave" frame (Lever's submit); otherwise that frame is tiny.
    const enclave = /hcaptcha\.com/.test(f.src) && r.width > 300 && r.height > 300;
    return (shown || enclave) && r.width > 100 && r.height > 60 && isVisible(f);
  });
}
export const captchaShown = () => !!challenge();

export function embeddedForm(): string | null {
  const f = deepQueryAll("iframe").find((f) => {
    const r = f.getBoundingClientRect();
    return RE_EMBED.test((f as HTMLIFrameElement).src) && r.width > 300 && r.height > 200;
  }) as HTMLIFrameElement | undefined;
  return f?.src ?? null;
}

const headings = () =>
  collapse(
    deepQueryAll("h1,h2,h3,[role=heading],[data-automation-id=progressBarActiveStep]")
      .filter(isVisible)
      .map((h) => h.innerText)
      .join(" | "),
  ).slice(0, 300);

/** `fields`: how many fields the fill scan sees on the page. */
export function pageFacts(fields: number): PageFacts {
  const c = challenge();
  return {
    text: pageText().slice(0, 4000),
    title: document.title,
    path: location.pathname,
    headings: headings(),
    alerts: alertText().slice(0, 600),
    fields,
    passwords: visiblePasswords().length,
    codeInput: !!codeInput(),
    captcha: !!c,
    cloudflare: !!c && /cloudflare/.test(c.src),
    embedded: !!embeddedForm(),
    apply: !!findApply(),
    onward: !!(findNext() || findSubmit()),
  };
}
