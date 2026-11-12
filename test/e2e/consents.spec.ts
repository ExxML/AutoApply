import { BASE, badge, expect, fillPage, PROFILE, seed, test, waitDone } from "./extension";

const topics = [
  ["consentToInterviewRecording", "I consent to recording my interview."],
  ["consentToAiReview", "I consent to AI tools reviewing my application."],
  ["consentToJobOpportunities", "I agree to receive alerts about new job opportunities."],
  ["consentToMarketing", "I agree to receive marketing communications."],
] as const;

for (const optionalConsents of ["accept", "decline", "ask"])
  for (const answer of ["yes", "no", ""])
    test(`Profile consents: ${answer || "Unset"} wins over optional ${optionalConsents}`, async ({
      page,
      sw,
      mock,
    }) => {
      await seed(sw, {
        caps: true,
        keys: 0,
        profile: { ...PROFILE, background: Object.fromEntries(topics.map(([key]) => [key, answer])) },
        settings: { optionalConsents, autoAcceptAcknowledgements: answer !== "yes", reviewFills: false },
      });
      await page.goto(BASE + "consent.html");
      await page.evaluate((topics) => {
        document.querySelector("form")!.innerHTML =
          topics
            .flatMap(([, label], i) =>
              [false, true].map(
                (required) => `
            <div><label><input type="checkbox" id="box-${i}-${required}" ${required ? "required" : ""}>${label}</label></div>
            <div><label for="choice-${i}-${required}">${label}</label>
              <select id="choice-${i}-${required}" ${required ? "required" : ""}>
                <option value="">Select...</option><option>Yes</option><option>No</option>
              </select></div>`,
              ),
            )
            .join("") +
          `<div><label><input id="sms" type="checkbox">I agree to receive SMS updates about this application.</label></div>`;
      }, topics);
      await fillPage(page, sw);
      await waitDone(page);
      for (let i = 0; i < topics.length; i++)
        for (const required of [false, true]) {
          await expect(page.locator(`#box-${i}-${required}`)).toBeChecked({ checked: answer === "yes" });
          await expect(page.locator(`#choice-${i}-${required}`)).toHaveValue(
            answer === "yes" ? "Yes" : answer === "no" ? "No" : "",
          );
        }
      if (!answer) await expect(page.locator("autoapply-root .needs")).toContainText("Consent not set in your Profile");
      await expect(page.locator("#sms")).toBeChecked({ checked: optionalConsents === "accept" });
      await expect(badge(page, "I agree to receive SMS updates about this application.")).toHaveAttribute(
        "data-color",
        optionalConsents === "ask" ? "yellow" : "blue",
      );
      expect(mock.calls.filter((c) => ["map", "audit", "guess"].includes(c.kind))).toEqual([]);
    });

test("Profile consents: mixed required checkbox groups obey each preference", async ({ page, sw }) => {
  await seed(sw, {
    profile: {
      ...PROFILE,
      background: { consentToJobOpportunities: "yes", consentToMarketing: "no", consentToAiReview: "no" },
    },
    settings: {
      optionalConsents: "accept",
      autoAcceptAcknowledgements: true,
      overwritePrefilled: true,
      reviewFills: false,
    },
  });
  await page.goto(BASE + "consent.html");
  await page.evaluate(() => {
    document.querySelector("form")!.innerHTML = `<fieldset><legend>Application agreements</legend>
      <label><input id="terms" name="agreements" type="checkbox" required>I agree to the Terms of Service</label>
      <label><input id="jobs" name="agreements" type="checkbox">Receive alerts about new job opportunities</label>
      <label><input id="marketing" name="agreements" type="checkbox" checked>Receive marketing communications</label>
      <label><input id="ai" name="agreements" type="checkbox" checked>I consent to AI tools reviewing my application</label>
    </fieldset>`;
  });
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#terms")).toBeChecked();
  await expect(page.locator("#jobs")).toBeChecked();
  await expect(page.locator("#marketing")).not.toBeChecked();
  await expect(page.locator("#ai")).not.toBeChecked();
});

test("Profile consents: combined Yes and Unset is flagged even with optional accept", async ({ page, sw }) => {
  await seed(sw, {
    profile: { ...PROFILE, background: { consentToJobOpportunities: "yes", consentToMarketing: "" } },
    settings: { optionalConsents: "accept", reviewFills: false },
  });
  await page.goto(BASE + "consent.html");
  await page.evaluate(() => {
    document.querySelector("form")!.innerHTML =
      `<label><input id="combined" type="checkbox" required>I agree to receive marketing communications and new job opportunities.</label>`;
  });
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#combined")).not.toBeChecked();
  await expect(page.locator("autoapply-root .needs")).toContainText("Consent not set in your Profile");
});

for (const answer of ["no", ""])
  test(`Profile consents: delayed dropdown honors ${answer || "Unset"} over optional accept`, async ({ page, sw }) => {
    await seed(sw, {
      profile: { ...PROFILE, background: { consentToMarketing: answer } },
      settings: { optionalConsents: "accept", reviewFills: false },
    });
    await page.goto(BASE + "consent.html");
    await page.evaluate(() => {
      document.querySelector("form")!.innerHTML = `<div>
        <label id="marketing-label">I consent to receive marketing communications.</label>
        <button id="marketing" type="button" role="combobox" aria-required="true" aria-labelledby="marketing-label"
          aria-haspopup="listbox" aria-controls="marketing-options" aria-expanded="false">Select...</button>
      </div>`;
      const control = document.querySelector<HTMLButtonElement>("#marketing")!;
      control.onclick = () => {
        if (document.querySelector("#marketing-options")) return;
        control.setAttribute("aria-expanded", "true");
        setTimeout(() => {
          const list = document.createElement("div");
          list.id = "marketing-options";
          list.setAttribute("role", "listbox");
          for (const text of ["Yes", "No"]) {
            const option = document.createElement("div");
            option.setAttribute("role", "option");
            option.textContent = text;
            option.onclick = () => {
              control.textContent = text;
              control.setAttribute("aria-expanded", "false");
              list.remove();
            };
            list.append(option);
          }
          document.body.append(list);
        }, 50);
      };
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          document.querySelector("#marketing-options")?.remove();
          control.setAttribute("aria-expanded", "false");
        }
      });
    });
    await fillPage(page, sw);
    await waitDone(page);
    await expect(page.locator("#marketing")).toHaveText(answer ? "No" : "Select...");
    if (!answer) await expect(page.locator("autoapply-root .needs")).toContainText("Consent not set in your Profile");
  });
