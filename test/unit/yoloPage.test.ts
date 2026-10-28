import { beforeAll, describe, expect, it } from "vitest";
import { setBody, stubLayout } from "./dom";
import { captchaShown, embeddedForm, pageFacts } from "../../src/content/yolo/classify";
import { confirmation, kindOf } from "../../src/background/yolo/classify";

const classify = (fields: number, hidden = false, requiredFields = 0) =>
  kindOf(pageFacts({ fields, requiredFields }), hidden);
import { findApply, findNext, findSubmit, validationErrors } from "../../src/content/yolo/nav";
import { siteKey } from "../../src/content/yolo/auth";

beforeAll(stubLayout);

describe("YOLO page kinds", () => {
  it("tells sign-in from sign-up by password fields and headings", () => {
    setBody(`<h2>Sign In</h2><input data-automation-id="email" type="email"><input data-automation-id="password" type="password">
      <button data-automation-id="signInSubmitButton">Sign In</button><button data-automation-id="createAccountLink">Create Account</button>`);
    expect(classify(1)).toBe("signin");
    setBody(`<h2>Create Account</h2><input type="email"><input type="password"><input type="password">`);
    expect(classify(1)).toBe("signup");
    setBody(`<h2>Create Account</h2><input type="email"><input type="password">`);
    expect(classify(1)).toBe("signup");
    setBody(`<h2>Reset your password</h2><input type="password"><input type="password">`);
    expect(classify(0)).toBe("reset");
  });

  it("knows confirmation, closed and bot-wall pages", () => {
    setBody(`<h1>Thank you for applying!</h1><p>We'll be in touch.</p>`);
    expect(classify(0)).toBe("success");
    // A form that merely mentions it is not done.
    setBody(`<p>Once your application has been submitted, we'll review it.</p><input><input><input>`);
    expect(classify(3)).toBe("form");
    setBody(`<h1>This job is no longer accepting applications</h1>`);
    expect(classify(0)).toBe("closed");
    setBody(`<h1>Just a moment...</h1>`);
    expect(classify(0)).toBe("blocked");
    // Ashby's bot score turned it down and left no form: load the page again.
    setBody(
      `<h2>We couldn't submit your application</h2><p>Your application submission was flagged as possible spam.</p>`,
    );
    expect(classify(0)).toBe("flagged");
  });

  it("quotes a confirmation page's message, else its headings", () => {
    setBody(`<h1>Application received</h1>`);
    const f = pageFacts({ fields: 0, requiredFields: 0 });
    const text = "Careers\nJobs\nThank you for applying!\n  We'll be   in touch.\n\nOpen roles\nFooter";
    expect(confirmation({ ...f, text })).toBe("Thank you for applying! We'll be in touch. Open roles");
    expect(confirmation({ ...f, text: "Careers\nAll done" })).toBe(f.headings);
  });

  it("asks for an emailed code, or a link", () => {
    setBody(`<h2>Verify your email</h2><p>We've sent a code to you.</p><input name="otp_code">`);
    expect(classify(1)).toBe("verify");
    setBody(`<h2>Check your inbox</h2><p>Click the link we emailed you.</p>`);
    expect(classify(0)).toBe("verify");
    setBody(`<h2>Forgot your password?</h2><input type="email"><button>Submit</button>`);
    expect(classify(1)).toBe("verify");
  });

  it("finds a visible CAPTCHA challenge, never the invisible score badge", () => {
    setBody(`<iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=x&size=invisible"></iframe>`);
    expect(captchaShown()).toBe(false);
    setBody(
      `<div style="visibility:hidden"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x"></iframe></div>`,
    );
    expect(captchaShown()).toBe(false);
    setBody(`<iframe src="https://www.google.com/recaptcha/api2/bframe?k=x"></iframe>`);
    // happy-dom boxes are 100 × 20 (dom.ts): too small for a challenge.
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 400,
      height: 580,
      top: 0,
      left: 0,
      right: 400,
      bottom: 580,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(captchaShown()).toBe(true);
    expect(classify(1)).toBe("captcha");
    // Once solved, the widget stays but its response token is set.
    document.body.insertAdjacentHTML("beforeend", `<textarea name="g-recaptcha-response">tok</textarea>`);
    expect(captchaShown()).toBe(false);
  });

  it("recognizes DataDome's full-page CAPTCHA frame", () => {
    setBody(`<iframe src="about:blank#https://geo.captcha-delivery.com/captcha/?cid=x"></iframe>`);
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(captchaShown()).toBe(true);
    // Unlike Cloudflare, this challenge should be handed to the user instead of retried in a background tab.
    expect(classify(0, true)).toBe("captcha");
  });

  it("sees hCaptcha's challenge in its page-sized frame only while shown (Lever)", () => {
    const enclave = (style: string) =>
      `<iframe style="${style}" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha-enclave.html#frame=en"></iframe>`;
    const big = () => {
      const f = document.querySelector("iframe")!;
      f.getBoundingClientRect = () => ({
        width: 1366,
        height: 900,
        top: 0,
        left: 0,
        right: 1366,
        bottom: 900,
        x: 0,
        y: 0,
        toJSON() {},
      });
    };
    setBody(enclave("visibility:hidden"));
    big();
    expect(captchaShown()).toBe(false);
    setBody(enclave(""));
    big();
    expect(captchaShown()).toBe(true);
  });

  it("does not mistake SmartRecruiters' support chat for an embedded application", () => {
    setBody(
      `<iframe src="https://eu.winstonchat.smartrecruiters.com/v2?parentUrl=https%3A%2F%2Fjobs.smartrecruiters.com%2FWesternDigital%2Fposting"></iframe>`,
    );
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 370,
      height: 404,
      top: 0,
      left: 0,
      right: 370,
      bottom: 404,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(embeddedForm()).toBeNull();
    expect(pageFacts({ fields: 0, requiredFields: 0 }).embedded).toBe(false);
    setBody(`<iframe src="https://jobs.smartrecruiters.com/oneclick-ui/company/WesternDigital/publication/id"></iframe>`);
    const application = document.querySelector("iframe")!;
    application.getBoundingClientRect = f.getBoundingClientRect;
    expect(embeddedForm()).toBe("https://jobs.smartrecruiters.com/oneclick-ui/company/WesternDigital/publication/id");
  });

  it("sends a Cloudflare check in the hidden frame to a tab, where it often passes by itself", () => {
    setBody(`<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"></iframe>`);
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 300,
      height: 65,
      top: 0,
      left: 0,
      right: 300,
      bottom: 65,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(classify(0, true)).toBe("blocked");
    expect(classify(0, false)).toBe("captcha");
  });

  it("tells a posting from a form", () => {
    setBody(`<h1>Software Engineer Intern</h1><p>About the role</p><a href="/apply">Apply now</a>`);
    expect(classify(0)).toBe("job");
    // A real link remains an application entrance even when surrounding job-page chrome has several controls.
    expect(classify(4)).toBe("job");
    // Indeed's posting has a What / Where search box.
    setBody(`<form><input aria-label="What"><input aria-label="Where"></form><button>Apply on company site</button>`);
    expect(classify(2)).toBe("job");
    // A job page can have several scan-visible filters/newsletter controls. Its specific CTA must still open the
    // application; a generic "Apply" at the end of a form does not get this exception.
    setBody(`<input aria-label="Keywords"><input aria-label="Location"><input aria-label="Email"><select aria-label="Team"><option>All</option></select><button>Apply to this job</button>`);
    expect(classify(4)).toBe("job");
    // A form action with the same wording must stay a form: its required fields need the normal fill, validation,
    // and (in test builds) dry-run path rather than a navigation click.
    setBody(`<form><input required><input required><input required><button type="submit">Apply to this job</button></form>`);
    expect(classify(3, false, 3)).toBe("form");
    setBody(`<input aria-required="true"><input aria-required="true"><input aria-required="true"><button type="button">Apply to this job</button>`);
    expect(classify(3, false, 3)).toBe("form");
    setBody(`<form><button type="submit">Apply</button></form>`);
    expect(classify(0)).toBe("form");
    setBody(`<h2>Review</h2><button>Submit application</button>`);
    expect(classify(0)).toBe("form");
    setBody(`<h1>Careers</h1>`);
    expect(classify(0)).toBe("unknown");
  });
});

describe("YOLO buttons", () => {
  it("prefers Workday's own controls, Apply Manually first", () => {
    setBody(`<button data-automation-id="adventureButton">Apply</button>
      <div role="dialog"><a data-automation-id="autofillWithResume" href="#">Autofill with Resume</a>
      <a data-automation-id="applyManually" href="#">Apply Manually</a></div>`);
    expect(findApply()?.dataset.automationId).toBe("applyManually");
    setBody(`<button data-automation-id="pageFooterNextButton">Save and Continue</button><button>Back</button>`);
    expect(findNext()?.textContent).toBe("Save and Continue");
  });

  it("skips third-party sign-ins and back buttons, and takes the form's own submit", () => {
    setBody(`<button>Apply with LinkedIn</button><button>Apply</button>`);
    expect(findApply()?.textContent).toBe("Apply");
    setBody(`<h2>Data Consent</h2><button>I Accept</button>`);
    expect(findNext()?.textContent).toBe("I Accept");
    setBody(`<button>Back</button><button>Continue</button>`);
    expect(findNext()?.textContent).toBe("Continue");
    setBody(`<button>Next →</button>`);
    expect(findNext()?.textContent).toBe("Next →");
    setBody(`<button>Save as draft</button><button type="submit">Submit application</button>`);
    expect(findSubmit()?.textContent).toBe("Submit application");
    setBody(`<button disabled>Submit</button>`);
    expect(findSubmit()).toBeNull();
  });

  it("reads validation messages", () => {
    setBody(
      `<div role="alert">Saved</div><div class="field-error">This field is required</div><input aria-invalid="true">`,
    );
    expect(validationErrors().map((e) => e.tagName)).toEqual(["DIV", "INPUT"]);
  });

  it("keys site accounts per Workday tenant", () => {
    expect(siteKey()).toBe(location.hostname.replace(/^www\./, ""));
  });
});
