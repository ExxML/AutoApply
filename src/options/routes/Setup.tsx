import { Meter } from "../components/controls";
import { Keys } from "../components/Keys";
import { ModelPicker } from "../components/ModelPicker";
import { Prefill } from "../components/Prefill";
import { DocumentUpload } from "./Documents";
import { completeness, useProfile, useStored } from "../store";

const STEPS = ["Add API key(s)", "Choose model", "Upload résumé", "Complete profile"];

export function Setup({ step }: { step: number }) {
  const keys = useStored("apiKeys") ?? [];
  const model = useStored("selectedModel");
  const docs = useStored("documentsIndex") ?? [];
  const [profile] = useProfile();
  const done = [
    keys.length > 0,
    !!model,
    docs.some((d) => d.isPrimaryResume),
    !!profile && completeness(profile) >= 80,
  ];
  const s = Math.min(Math.max(step, 1), 4);
  const go = (n: number) => (location.hash = `#/setup/${n}`);
  return (
    <section>
      <h1>Setup</h1>
      {profile && <Meter label="Profile completeness" value={completeness(profile)} />}
      <ol class="steps">
        {STEPS.map((t, i) => (
          <li class={`${i + 1 === s ? "current" : ""} ${done[i] ? "done" : ""}`}>
            <a href={`#/setup/${i + 1}`} aria-current={i + 1 === s ? "step" : undefined}>
              {done[i] ? "✓ " : `${i + 1}. `}
              {t}
            </a>
          </li>
        ))}
      </ol>
      {s === 1 && <Keys />}
      {s === 2 && <ModelPicker />}
      {s === 3 && (
        <div class="panel-box">
          <h2>Upload your résumé (PDF)</h2>
          <p>It is attached to résumé fields automatically, and its text helps the AI answer questions.</p>
          <DocumentUpload />
          {docs.some((d) => d.isPrimaryResume) && <Prefill />}
        </div>
      )}
      {s === 4 && (
        <div class="panel-box">
          <h2>Complete your profile</h2>
          <p>The more you fill in, the fewer fields need you. Every field explains how it is used.</p>
          <a class="btn primary" href="#/profile/personal">
            Open the profile editor
          </a>
          {done.every(Boolean) && (
            <p class="ok">You're all set — open a job application and it will fill automatically.</p>
          )}
        </div>
      )}
      <div class="row wizard-nav">
        <button type="button" class="btn" disabled={s === 1} onClick={() => go(s - 1)}>
          Back
        </button>
        {s < 4 && (
          <button type="button" class="btn primary" onClick={() => go(s + 1)}>
            {done[s - 1] ? "Continue" : "Skip for now"}
          </button>
        )}
      </div>
    </section>
  );
}
