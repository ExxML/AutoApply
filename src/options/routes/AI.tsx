import { Keys } from "../components/Keys";
import { ModelPicker } from "../components/ModelPicker";

export function AI() {
  return (
    <section>
      <h1>AI (Gemini)</h1>
      <p class="intro">
        All AI calls go directly from your browser to Google Gemini with your own keys. Keys are sent only to Google,
        never to web pages or content scripts.
      </p>
      <Keys />
      <ModelPicker showFallback />
    </section>
  );
}
