// Service-worker entry. Separate from index.ts only so its emitted chunk name differs from the
// content script's (CRXJS + Rolldown resolve two "index.ts" chunks to the same file).
import "./index";
