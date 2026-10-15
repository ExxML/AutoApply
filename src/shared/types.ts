// Shared TypeScript types. Type-only re-exports keep zod out of the content bundle.
import type { FIELD_KINDS, LearnedAnswer, Profile } from "./profileSchema";
import type { Settings } from "./settings";

export type { Profile, LearnedAnswer, Settings };

export type YesNo = "yes" | "no" | "";
export type YesNoDecline = "yes" | "no" | "decline" | "";
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldDescriptor {
  id: string;
  kind: FieldKind;
  label: string;
  hint?: string;
  section?: string;
  required: boolean;
  placeholder?: string;
  inputType?: string;
  autocomplete?: string;
  nameAttr?: string;
  maxLength?: number;
  options?: string[];
  optionsKnown: boolean;
  multiple?: boolean;
  currentValue?: string;
  accept?: string;
}

export type DecisionAction = "fill" | "essay" | "consent" | "skip" | "flag";
export type Confidence = "high" | "medium" | "low";

export interface Decision {
  fieldId: string;
  action: DecisionAction;
  text?: string;
  optionIndexes?: number[];
  intendedAnswer?: string;
  searchQuery?: string;
  checked?: boolean;
  documentId?: string;
  confidence: Confidence;
  sources?: string[];
  note?: string;
  /** Best guess kept for the tooltip when a decision is downgraded to flag. */
  suggestion?: string;
}

export interface CachedDecision {
  action: "fill";
  text?: string;
  optionTexts?: string[];
  checked?: boolean;
  documentId?: string;
  source: "ai";
  savedAt: number;
}

export interface DocumentMeta {
  id: string;
  label: string;
  kind: "resume" | "cover_letter" | "transcript" | "other";
  fileName: string;
  mimeType: string;
  size: number;
  isPrimaryResume: boolean;
  uploadedAt: number;
}

export interface ApiKeyEntry {
  id: string;
  label: string;
  key: string;
  addedAt: number;
}

export interface KeyState {
  invalid?: { reason: string; at: number };
  cooldownUntil?: number;
  perModel?: Record<string, { exhaustedUntil?: number; unavailableUntil?: number }>;
  lastUsedAt?: number;
  lastError?: { status: number; message: string; at: number };
  successCount: number;
  errorCount: number;
}

export interface CatalogEntry {
  firstSeenAt: number;
  apiIndex: number;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  thinking?: boolean;
  lastSeenAt: number;
}

export type ThinkingCap = { kind: "level"; value: "minimal" | "low" } | { kind: "budget"; value: 0 } | { kind: "none" };

export interface ModelCaps {
  thinking: ThinkingCap;
  schema: "responseSchema" | "promptOnly";
  verifiedAt: number;
  essayThinking?: ThinkingCap;
}

export interface JobContext {
  url: string;
  title: string;
  company: string;
  jobTitle: string;
  text: string;
  capturedAt: number;
}

export interface LearnedAnswerInput {
  question: string;
  kind: FieldKind;
  options?: string[];
  answer: string;
  host: string;
}

export interface StatusCounts {
  total: number;
  filled: number;
  aiMatched: number;
  aiDrafted: number;
  needsYou: number;
  failed: number;
  prefilled: number;
  skipped: number;
}

export interface NeedsYouItem {
  fieldId: string;
  label: string;
  note: string;
  frameId?: number;
}

export interface FrameStatus {
  frameId: number;
  counts: StatusCounts;
  needsYou: NeedsYouItem[];
  running: boolean;
  error?: string;
  detected?: boolean;
}

export interface TabStatus {
  frames: Record<string, FrameStatus>;
  updatedAt: number;
}

export interface ChooseItem {
  fieldId: string;
  question: string;
  intendedAnswer: string;
  options: string[];
  multiple: boolean;
}

export interface Choice {
  fieldId: string;
  optionIndexes: number[] | null;
  confidence: Confidence;
}

export interface EssayItem {
  fieldId: string;
  question: string;
  hint?: string;
  maxChars?: number;
  maxWords?: number;
  kind: "essay" | "cover_letter";
}

export interface DeterministicProfile {
  personal: Profile["personal"];
  learnedAnswers: Pick<LearnedAnswer, "id" | "question" | "normalizedQuestion" | "kind" | "options" | "answer">[];
}

export interface RuntimeConfig {
  settings: Settings;
  profileSnapshotForDeterministic: DeterministicProfile;
  documentsIndex: DocumentMeta[];
  /** The tab's host is in settings.excludedHosts. */
  excluded: boolean;
  selectedModel: string | null;
  hasKeys: boolean;
  overlayBottom: number | null;
}

export type ApiErrorKind = "allKeysExhausted" | "noKey" | "noModel" | "modelGone" | "blocked" | "badOutput" | "other";

export interface ApiError {
  kind: ApiErrorKind;
  message: string;
  earliestRetryAt?: number;
}
