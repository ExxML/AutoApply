import { NumberInput, TagInput, Toggle } from "../components/controls";
import { save, useStored } from "../store";
import type { Settings } from "../../shared/types";

type Bool = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type Num = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

const TOGGLES: [Bool, string, string][] = [
  [
    "autoFillOnDetect",
    "Auto-fill on job pages",
    "Start filling as soon as an application form is detected. Per-site overrides live in the popup.",
  ],
  ["overwritePrefilled", "Overwrite pre-filled fields", "Off: fields that already have a value are left alone."],
  [
    "autoAcceptAcknowledgements",
    "Auto-accept acknowledgements",
    "Off: consent/attestation checkboxes are flagged for you instead of ticked.",
  ],
  [
    "draftEssays",
    "Draft essays with AI",
    "Open-ended questions are drafted and badged “AI draft – review”. Off: they are flagged for you.",
  ],
  ["showBadges", "Show field badges", "Colored outlines and tags on each field. The overlay list works either way."],
  [
    "learnPrompts",
    "Offer to save my answers",
    "After you answer a field the extension couldn't, offer to remember it.",
  ],
  [
    "debugLogging",
    "Debug logging",
    "Logs prompts and responses to the service-worker console (never API keys) and shows stage timings.",
  ],
];

const NUMBERS: [Num, string, string, number, number][] = [
  ["detectionThreshold", "Detection threshold", "Pages scoring at least this (0–100) auto-fill.", 0, 100],
  [
    "maybeThreshold",
    "“Maybe” threshold",
    "Pages scoring between this and the detection threshold show an “Autofill this page” pill.",
    0,
    100,
  ],
  ["essayDefaultWords", "Essay length (words)", "Target length when a question gives no limit.", 10, 2000],
  ["coverLetterDefaultWords", "Cover letter length (words)", "Target length for cover-letter text boxes.", 10, 2000],
  [
    "maxFieldsPerRequest",
    "Fields per AI request",
    "Larger pages are split into parallel requests of this size.",
    1,
    200,
  ],
  ["requestTimeoutMs", "Request timeout (ms)", "Per AI request; essays get twice this.", 1000, 120000],
  ["maxConcurrentRequests", "Parallel AI requests", "How many Gemini calls may run at once.", 1, 16],
];

export function Behavior() {
  const s = useStored("settings");
  if (!s) return <p>Loading…</p>;
  const set = (patch: Partial<Settings>) => void save({ settings: { ...s, ...patch } });
  return (
    <section>
      <h1>Behavior</h1>
      <div class="form">
        {TOGGLES.map(([k, label, help]) => (
          <Toggle label={label} help={help} checked={s[k]} onChange={(v) => set({ [k]: v })} />
        ))}
        {NUMBERS.map(([k, label, help, min, max]) => (
          <NumberInput label={label} help={help} value={s[k]} min={min} max={max} onChange={(v) => set({ [k]: v })} />
        ))}
        <TagInput
          label="Excluded sites"
          help="Host names where the extension does nothing at all, e.g. mail.google.com."
          value={s.excludedHosts}
          onChange={(v) =>
            set({
              excludedHosts: v.map((h) =>
                h
                  .toLowerCase()
                  .replace(/^https?:\/\//, "")
                  .replace(/\/.*$/, ""),
              ),
            })
          }
        />
      </div>
    </section>
  );
}
