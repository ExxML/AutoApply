// What kind of page a YOLO run is on, read from the page alone.
import { RE_APPLIED } from "../../shared/constants";
import { collapse } from "../../shared/normalize";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { findApply, findNext, findSubmit } from "./nav";

export type Kind =
  | "captcha"
  | "success"
  | "blocked"
  | "closed"
  | "verify"
  | "reset"
  | "signup"
  | "signin"
  | "embedded"
  | "form"
  | "job"
  | "unknown";

const RE_BLOCKED =
  /just a moment|verify(ing)? (that )?you are (a )?human|access denied|attention required|unusual traffic|are you a robot|request unsuccessful|you have been blocked/i;
const RE_CLOSED =
  /no longer (accepting|available|open|active)|(job|position|posting|role|requisition|opening) (has been |is )?(closed|filled|expired|removed|unavailable)|(page|job) (you('re| are) looking for )?(can'?t|cannot|could not) be found|\b(page|job) not found\b|this job has expired/i;
const RE_VERIFY =
  /verify your (email|account|identity)|(verification|confirmation|security) (code|email|link)|check your (email|inbox)|we('ve| have)? (just )?sent (you )?(an? )?(email|code|link)|enter the (\d+[- ]digit )?code|one[- ]time (pass)?code/i;
const RE_RESET = /(reset|new|change|create) (your )?password/i;
const RE_SIGNUP = /create (an |your )?account|sign ?up|register|new (user|candidate)/i;

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

/** A challenge someone must solve: a visible image/checkbox frame, never the invisible score badge. */
export function captchaShown(): boolean {
  return deepQueryAll("iframe").some((f) => {
    const src = (f as HTMLIFrameElement).src;
    const challenge =
      /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*frame=challenge|challenges\.cloudflare\.com/.test(src) ||
      (/recaptcha\/(api2|enterprise)\/anchor|hcaptcha\.com.*frame=checkbox/.test(src) && !/size=invisible/.test(src));
    const r = f.getBoundingClientRect();
    return challenge && r.width > 100 && r.height > 60 && isVisible(f);
  });
}

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
export function classify(fields: number): Kind {
  const text = pageText();
  if (captchaShown()) return "captcha";
  if (
    fields < 3 &&
    (RE_APPLIED.test(text) || /\/(thanks|thank-you|confirmation|success|submitted)\b/i.test(location.pathname))
  )
    return "success";
  if (text.length < 2000 && (RE_BLOCKED.test(text) || RE_BLOCKED.test(document.title))) return "blocked";
  if (fields < 2 && RE_CLOSED.test(text)) return "closed";
  const pw = visiblePasswords().length;
  if (RE_VERIFY.test(text) && (codeInput() || !pw)) return "verify";
  if (!pw && /forgot (your )?password|reset (your )?password/i.test(headings())) return "verify";
  if (pw >= 2) return RE_RESET.test(headings()) ? "reset" : "signup";
  if (pw === 1) return RE_SIGNUP.test(headings()) && !/sign ?in|log ?in/i.test(headings()) ? "signup" : "signin";
  if (fields < 3 && embeddedForm()) return "embedded";
  if (fields > 0) return "form";
  if (findApply()) return "job";
  // A review step: nothing to fill, only the way on.
  if (findNext() || findSubmit()) return "form";
  return "unknown";
}

/** What distinguishes one step from the next, for the background's loop detection. */
export const signature = (kind: Kind, fields: number) => `${kind}|${location.pathname}|${headings()}|${fields}`;
