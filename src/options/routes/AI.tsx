import { Keys } from "../components/Keys";
import { ModelPicker } from "../components/ModelPicker";

export function AI() {
  return (
    <section>
      <h1>AI (Gemini)</h1>
      <p class="intro">
        All AI calls go directly from your browser to Google Gemini with your own keys. Keys never leave this
        extension's background worker.
      </p>
      <Keys />
      <ModelPicker showFallback />
    </section>
  );
}
