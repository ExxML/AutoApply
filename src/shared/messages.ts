import type {
  ApiError,
  Choice,
  ChooseItem,
  Decision,
  DocumentMeta,
  EssayItem,
  FieldDescriptor,
  FrameStatus,
  JobContext,
  LearnedAnswerInput,
  Profile,
  RuntimeConfig,
  TabStatus,
} from "./types";

/** Typed message protocol (§17). `C` = content script, `B` = background, `O` = options page. */
export type Message =
  // C → B
  | { type: "GET_RUNTIME_CONFIG" }
  | { type: "GET_DOCUMENT"; id: string }
  | { type: "SET_JOB_CONTEXT"; ctx: JobContext }
  | { type: "MAP_FIELDS"; fields: FieldDescriptor[]; host: string; groupId: string }
  | { type: "CHOOSE_OPTIONS"; items: ChooseItem[]; groupId: string }
  | { type: "DRAFT_ESSAYS"; items: EssayItem[]; groupId: string }
  | { type: "SAVE_LEARNED_ANSWER"; answer: LearnedAnswerInput }
  | { type: "LEARNED_USED"; ids: string[] }
  | { type: "FRAME_STATUS"; status: FrameStatus }
  | { type: "ABORT"; groupId: string }
  | { type: "BROADCAST_FILL"; rerun: boolean }
  | { type: "SET_OVERLAY_POS"; host: string; bottom: number }
  | { type: "OPEN_OPTIONS"; hash: string }
  // B/popup → C
  | { type: "TRIGGER_FILL"; force: boolean; rerun?: boolean }
  | { type: "FOCUS_FIELD"; frameId: number; fieldId: string }
  // popup → B
  | { type: "TAB_STATUS"; tabId: number }
  // O → B
  | { type: "ADD_KEY"; label: string; key: string }
  | { type: "TEST_KEY"; id: string }
  | { type: "REFRESH_MODELS"; force: boolean }
  | { type: "VALIDATE_MODEL"; model: string }
  | { type: "PARSE_RESUME"; text: string };

export type Ok = { ok: true };
export type Err = { error: ApiError };

export interface TabStatusResponse {
  status: TabStatus | null;
  model: string | null;
  keysTotal: number;
  keysHealthy: number;
}

export interface Responses {
  GET_RUNTIME_CONFIG: RuntimeConfig;
  GET_DOCUMENT: { meta: DocumentMeta; base64: string } | null;
  SET_JOB_CONTEXT: Ok;
  MAP_FIELDS: { decisions: Decision[]; usedModel: string } | Err;
  CHOOSE_OPTIONS: { choices: Choice[] } | Err;
  DRAFT_ESSAYS: { essays: { fieldId: string; text: string | null; note?: string }[] } | Err;
  SAVE_LEARNED_ANSWER: Ok;
  LEARNED_USED: Ok;
  FRAME_STATUS: Ok;
  ABORT: Ok;
  BROADCAST_FILL: Ok;
  SET_OVERLAY_POS: Ok;
  OPEN_OPTIONS: Ok;
  TRIGGER_FILL: Ok;
  FOCUS_FIELD: Ok;
  TAB_STATUS: TabStatusResponse;
  ADD_KEY: Ok | Err;
  TEST_KEY: Ok | Err;
  REFRESH_MODELS: Ok | Err;
  VALIDATE_MODEL: Ok | Err;
  PARSE_RESUME: { proposed: Partial<Profile> } | Err;
}

/** Sends to the background and resolves with the typed response. */
export function send<M extends Message>(msg: M): Promise<Responses[M["type"]]> {
  return chrome.runtime.sendMessage(msg) as Promise<Responses[M["type"]]>;
}

export function isErr(r: unknown): r is Err {
  return !!r && typeof r === "object" && "error" in r;
}
