<div align="center" markdown="1">

<img src="public/icons/128.png" alt="AutoApply Icon" width="128" height="128">

# AutoApply

A Chrome extension (Manifest V3) that fills job applications on any website from your profile, using Google Gemini with your own API keys. It fills; **you** review and submit.

[![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-MV3-34A853?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Preact](https://img.shields.io/badge/Preact-673AB8?logo=preact&logoColor=white)](https://preactjs.com/)
[![Gemini API](https://img.shields.io/badge/Gemini_API-2496ED?logo=google&logoColor=white)](https://ai.google.dev/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-orange.svg)](https://www.gnu.org/licenses/gpl-3.0)

### Check it out! [AutoApply on Chrome Web Store]()

</div>

## Table of Contents
- [App Preview](#-app-preview)
- [Install](#install)
  - [Get Gemini API keys](#get-gemini-api-keys)
  - [Choose a model](#choose-a-model)
  - [Fill in your profile](#fill-in-your-profile)
  - [How filling works](#how-filling-works)
- [Badge meanings](#badge-meanings)
- [Privacy](#privacy)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## App Preview
<div align="center">
  <img src="docs/app_previews/extension_popup.png" alt="AutoApply Popup" height="247">
  <img src="docs/app_previews/settings_setup.png" alt="AutoApply Setup Settings" height="247">
</div>

<div align="center">
  <img src="docs/app_previews/settings_behaviour.png" alt="AutoApply Behaviour Settings" width="800">
</div>

## Install

Requirements: Node 20+ and Chrome/Chromium 120+.

```bash
npm install
npm run build          # produces dist/
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist/` folder.

The settings page opens on first install at the setup wizard.

### Get Gemini API keys

1. Go to <https://aistudio.google.com/apikey> and create a key.
2. In AutoApply → **Setup** (or **AI (Gemini)**), paste it with a label and click **Add key**. The key is checked by fetching the model list; invalid keys are rejected with Google's error message.
3. Add more keys if you hit rate limits. AutoApply rotates to the next healthy key automatically when one returns a quota or rate-limit error.

> **Rate limits apply per Google Cloud project, not per key. Keys created in the same project share one quota.** To get more capacity, create keys in _separate_ projects.

Each key row shows a status chip: _Healthy_, _Cooling down until 14:32_, _Daily quota used for &lt;model&gt; until 00:00 PT_, _Invalid key_, or _Model unavailable on this key_. Daily quotas reset at midnight Pacific time.

### Choose a model

The model list is fetched live with your key and shows only text-in/text-out models that support `generateContent` (no embedding, image, audio, live, TTS or Gemma models), **newest-added first**. A Flash-Lite model is preselected because it is fast and cheap; picking a model runs a quick validation call (✓/✗). You can also set an optional **fallback model**, used automatically when every key is exhausted for the primary model. Click **Refresh list** to re-fetch (it also refreshes automatically once a day).

### Fill in your profile

- **Setup → Upload résumé (PDF)**: it is attached to résumé/CV upload fields automatically, and its text (extracted locally with pdf.js) is given to Gemini as context. **Prefill profile from résumé** proposes values for empty profile fields only; tick what to keep.
- **Profile**: contact details, work authorization per country, education, co-op, experience, projects, skills, preferences, background, referral, self-identification and essay guidance. Every field explains how it is used. Changes save automatically.
- Yes/No questions have **Unset**, and sensitive ones also **Decline**: _Decline_ picks the "prefer not to say" option when the form offers it; _Unset_ means the field is flagged for you.
- **Documents**: upload PDF/DOCX/TXT (≤ 5 MB) and mark one PDF as the primary résumé.

### How filling works

1. Click **Fill this page** in the popup or press **Alt+Shift+F**. AutoApply never starts on its own; it scans the page (including iframes and shadow DOM) only when you ask.
2. Instant pass (no network): name, email, phone, address and links are matched from your profile; questions you answered before (saved answers) fill immediately.
3. Everything else goes to Gemini in one batched call. It picks options **by meaning** (e.g. "willing to relocate = yes" → "I am willing to relocate"), and custom dropdowns and typeaheads are operated one at a time.
4. Open-ended questions ("Why do you want to work here?") are drafted by Gemini from your profile, résumé and the job description, respecting word/character limits, and marked as AI drafts.
5. Multi-step applications: when the next step appears, click **Fill this page** (or press **Alt+Shift+F**) again. AutoApply does not watch the page between fills.
6. The panel at the bottom right shows progress, the model used, and a **Needs you** list; click a row to jump to the field. **Re-run** and **Stop** are there too. Press **Alt+Shift+W** to expand or collapse it.
7. When you answer a flagged field yourself, AutoApply offers to **save the answer** for future applications (see **Saved answers** in settings).

## Badge meanings

| Badge                | Meaning                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Green ✓              | Filled from your profile or a saved answer ("You"/"Saved" once you answered it yourself)                                               |
| Blue **AI**          | Filled by Gemini's semantic match (hover for the profile fields used and the chosen option)                                            |
| Purple **AI draft**  | AI-written essay — review it. Click the tag to save it as a reusable answer                                                            |
| Yellow **Needs you** | Unknown, low confidence, a consent/acknowledgement box, a sensitive field, or the AI declined. Hover for the reason and any suggestion |
| Orange **Check**     | The page shows something different from what was entered                                                                               |
| Red **Failed**       | Could not be filled                                                                                                                    |

Consent and attestation boxes are **flagged, not ticked**, unless you turn on _Auto-accept required consents_ (privacy notice, terms, attestations) in **Behavior**. _Optional consents_ (contact about other jobs, talent community, marketing) are set separately: flag for you (default), auto-accept, or auto-decline.

## Privacy

Your profile, documents and settings live only in this browser (`chrome.storage.local`). To answer questions, the extension sends your profile, résumé text, saved answers and the page's field labels/job description **to Google Gemini under your own API keys**; there is no AutoApply server, analytics or telemetry. API keys stay in the extension's background worker — web pages and content scripts never see them, they are masked after entry, and exports exclude them unless you tick **Include API keys**.

## Limitations

- Custom calendar date pickers that refuse typed input are flagged ("Pick the date manually").
- CAPTCHAs, passwords, payment fields and government ID numbers are never filled.
- Some sites reject synthetic events (mostly heavily customized widgets); those fields are marked _Failed_ or _Check_.
- Upload dropzones inside cross-origin iframes or that only accept real OS drag-and-drop may need a manual upload ("Upload the file manually").
- It never submits or navigates: you always click Next/Submit yourself.

## Troubleshooting

- **"The model is overloaded" (503)**: requests are retried, then the **fallback model** is used if you set one (AI settings). Choosing a different primary model also helps.
- **"All API keys are rate-limited … Next retry possible at …"**: you hit a quota. The panel retries automatically if the reset is within 90 s. Add keys from **separate Google Cloud projects**, or wait for the daily reset (midnight Pacific).
- **"Model unavailable on this key"**: the model is not on your key's tier/region; pick another model.
- **"No API key" / "No model selected"**: open the AI settings from the panel's button.
- **Nothing happens on a page**: use **Fill this page** in the popup (or **Alt+Shift+F**), check that the site isn't excluded (Behavior), and reload pages that were open before the extension was installed or updated.
- Turn on **Debug logging** (Behavior) to see per-stage timings in the panel and prompts/responses in the service-worker console (keys are never logged).

## Development

```bash
npm run build       # type-check + production build → dist/
npm run lint        # eslint + prettier --check
npm test            # unit tests (Vitest + happy-dom)
npm run test:e2e    # build, then end-to-end tests with the unpacked extension and a mocked Gemini
npm run test:live   # build, then a smoke test against the real Gemini API
```

**End-to-end tests** use Playwright's bundled Chromium in its new headless mode (`channel: "chromium"`), which supports extensions, so no display server or `xvfb` is needed. Run `npx playwright install chromium` once. Fixture pages in `test/fixtures` are served on ports 5501 and 5502 (for a cross-origin iframe); `test/mockGemini.ts` intercepts `generativelanguage.googleapis.com` (including the service worker's requests) and can simulate per-minute and daily 429s, `limit: 0`, 503s, invalid keys and slow responses.

**Live smoke test** (`npm run test:live`) runs `semantic.html` and `plain.html` against the real API and asserts the semantic selections (relocation, negatively phrased sponsorship, EEO decline). It is skipped unless `GEMINI_API_KEY` is set; `GEMINI_MODEL` overrides the model (default: the first Flash-Lite model in the live list).

```bash
# PowerShell
$env:GEMINI_API_KEY = "AIza..."; npm run test:live
# bash
GEMINI_API_KEY=AIza... npm run test:live
```

See `DECISIONS.md` for design choices and deviations from the specification.


## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).