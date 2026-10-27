import { ClaudeConnect, ClaudeModels, ProviderPicker } from "../components/Claude";
import { Keys } from "../components/Keys";
import { ModelPicker } from "../components/ModelPicker";
import { useStored } from "../store";

export function AI() {
  const provider = useStored("settings")?.aiProvider;
  return (
    <section>
      <h1>AI</h1>
      <ProviderPicker />
      {provider === "claude" && (
        <>
          <ClaudeConnect />
          <ClaudeModels />
        </>
      )}
      {provider === "gemini" && (
        <>
          <Keys />
          <ModelPicker showFallback />
        </>
      )}
    </section>
  );
}
