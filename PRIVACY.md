# AutoApply Privacy Policy

_Effective date: October 15, 2026_

AutoApply is a Chrome extension that fills job application forms from a profile you create. This policy explains what data it handles and where that data goes.

**Summary:** AutoApply has no servers and the developer never receives your data. Everything is stored in your browser. Data leaves your device only when the extension sends it to Google's Gemini API, using the API key you provide, to answer application questions.

## Data AutoApply handles

- **Profile information you enter:** name, contact details (email, phone, address), links, work authorization, education, work experience, projects, skills, job preferences, essay guidance, and optional self-identification answers (such as gender, race/ethnicity, veteran status and disability status).
- **Documents you upload:** your résumé and other files (PDF, DOCX, TXT), plus text extracted from your résumé. Text extraction runs locally in your browser.
- **Saved answers:** answers you choose to save from application forms so they can be reused.
- **Gemini API keys** that you add, and your extension settings.
- **Page content on job application pages:** form field labels and options, plus the job title, company, URL and job description text. AutoApply reads these only to fill out the form.

AutoApply does not collect browsing history, analytics, telemetry, or payment information.

## How data is stored

All of the data above is stored locally with Chrome's extension storage (`chrome.storage.local`, and `chrome.storage.session` for temporary per-tab state). Nothing is synced to the developer or to any developer-run server.

## When data leaves your device

When AutoApply fills a form, it may send data to the **Google Gemini API** (`generativelanguage.googleapis.com`) to map form fields, choose answers, or draft essay answers. A request can include:

- form questions and options from the page
- relevant profile information (including self-identification answers, which are used only for matching questions on the form)
- your résumé text
- the job title, company, URL and description

Requests are authenticated with **your own** Gemini API key. Google processes them under its own terms: the [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms) and the [Google Privacy Policy](https://policies.google.com/privacy). Depending on your Google account and API tier, Google may use the data to improve its products. See Google's terms for details.

AutoApply attaches your uploaded documents to file-upload fields on the application page you are filling. It never clicks Submit. Information is sent to the employer's site only when you submit the application yourself.

No other third parties receive your data.

## How data is used

AutoApply uses your data only to fill job applications and for nothing else. Your data is not sold, transferred to third parties (other than Google, as described above), used for advertising, or used to decide creditworthiness or lending eligibility.

## Your control

- You can view, edit or delete any profile field, document, saved answer or API key in the extension's settings.
- **Settings → Data** lets you export your data to a file or clear it all.
- Uninstalling the extension deletes all of its locally stored data.

## Permissions

- **Access to all sites:** job applications appear on many different domains. AutoApply reads forms on pages only to detect and fill applications.
- **storage / unlimitedStorage:** stores your profile and uploaded documents locally.
- **scripting, tabs, webNavigation:** run the form filler on open tabs, respond to the popup and the keyboard shortcut, and detect page changes in multi-step applications.

## Changes

If this policy changes, the updated version will be posted here with a new effective date.

## Contact

Questions or requests: open an issue at <https://github.com/ExxML/AutoApply/issues>.
