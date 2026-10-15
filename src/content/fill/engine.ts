// §14 fill dispatcher: picks the right strategy per kind; dropdowns/typeaheads run strictly one at a time.
import { normalize } from "../../shared/normalize";
import type { DocumentMeta } from "../../shared/types";
import { localMatch, localMatchAll } from "../match/localMatch";
import type { FieldHandle } from "../scan/fields";
import { fillDropdown, harvestOptions } from "./dropdown";
import { holdScroll } from "./events";
import { compatibleDoc, fillFile } from "./file";
import {
  fillCheckbox,
  fillCheckboxGroup,
  fillContentEditable,
  fillRadio,
  fillSelect,
  fillText,
  type FillResult,
} from "./native";
import { fillTypeahead } from "./typeahead";

export type { FillResult };

export type FillOp =
  | { type: "text"; value: string }
  | { type: "options"; texts: string[] }
  | { type: "intended"; answer: string; query?: string }
  | { type: "checked"; value: boolean }
  | { type: "file"; documentId: string };

export interface EngineDeps {
  documents: DocumentMeta[];
  getDocument(id: string): Promise<{ meta: DocumentMeta; base64: string } | null>;
  /** AI fallback (chooseOptions) for options discovered late. */
  choose(h: FieldHandle, intended: string, options: string[]): Promise<number[] | null>;
  checkedByUs: Set<Element>;
  harvested: Map<string, string[]>;
  signal: AbortSignal;
}

const SERIAL = new Set(["dropdown", "typeahead"]);
let chain: Promise<unknown> = Promise.resolve();

export function fill(h: FieldHandle, op: FillOp, deps: EngineDeps): Promise<FillResult> {
  const run = () =>
    deps.signal.aborted ? Promise.resolve<FillResult>({ outcome: "flag", note: "Stopped" }) : dispatch(h, op, deps);
  return SERIAL.has(h.desc.kind) ? serial(run) : holdScroll(run);
}

/** Runs `fn` after every queued dropdown/typeahead operation (one popup open at a time). */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const held = () => holdScroll(fn);
  const p = chain.then(held, held);
  chain = p.catch(() => undefined);
  return p;
}

const flag = (note: string): FillResult => ({ outcome: "flag", note });
const answerOf = (op: FillOp) =>
  op.type === "intended"
    ? op.answer
    : op.type === "text"
      ? op.value
      : op.type === "options"
        ? op.texts.join(" | ")
        : "";

/** Option texts for an op against a known option list (local, safe matching only). */
function textsFor(op: FillOp, options: string[]): string[] | null {
  if (op.type === "options") {
    const known = op.texts.filter((t) => options.some((o) => normalize(o) === normalize(t)));
    return known.length === op.texts.length ? op.texts : null;
  }
  const idx = localMatchAll(answerOf(op), options);
  return idx ? idx.map((i) => options[i]) : null;
}

async function dispatch(h: FieldHandle, op: FillOp, deps: EngineDeps): Promise<FillResult> {
  try {
    const kind = h.desc.kind;
    switch (kind) {
      case "text":
      case "email":
      case "tel":
      case "url":
      case "number":
      case "date":
      case "month":
      case "textarea":
        return fillText(h, answerOf(op));
      case "contenteditable":
        return fillContentEditable(h, answerOf(op));
      case "checkbox":
        return op.type === "checked" ? fillCheckbox(h, op.value) : flag("Needs your confirmation");
      case "select":
      case "multiselect":
      case "radio_group":
      case "checkbox_group": {
        const texts = textsFor(op, h.desc.options ?? []);
        if (!texts) return flag(`Suggested: ${answerOf(op)}`);
        if (kind === "radio_group") return fillRadio(h, texts[0]);
        if (kind === "checkbox_group") return fillCheckboxGroup(h, texts, deps.checkedByUs);
        return fillSelect(h, kind === "select" ? texts.slice(0, 1) : texts);
      }
      case "dropdown": {
        if (op.type === "options") return fillDropdown(h, op.texts);
        let options = h.desc.options ?? deps.harvested.get(h.id) ?? null;
        if (!options) {
          // Fast path: the intended answer is usually an exact option (scrolls virtualized lists to it).
          const direct = await fillDropdown(h, [answerOf(op)]);
          if (direct.outcome === "ok") return direct;
          options = await harvestOptions(h);
          if (options) deps.harvested.set(h.id, options);
        }
        if (!options) {
          if (!h.searchInput) return flag("Could not open the list");
          return fillTypeahead({ ...h, el: h.searchInput }, answerOf(op), answerOf(op), (o) =>
            deps.choose(h, answerOf(op), o).then((r) => r?.[0] ?? null),
          );
        }
        let texts = textsFor(op, options);
        if (!texts) {
          const idx = await deps.choose(h, answerOf(op), options);
          texts = idx?.length ? idx.map((i) => options[i]) : null;
        }
        if (!texts) return flag(`Suggested: ${answerOf(op)}`);
        return fillDropdown(h, h.desc.multiple ? texts : texts.slice(0, 1));
      }
      case "typeahead": {
        const answer = answerOf(op);
        const query = op.type === "intended" ? op.query || answer : answer;
        return fillTypeahead(h, query, answer, async (o) => {
          const local = localMatch(answer, o);
          return local ?? (await deps.choose(h, answer, o))?.[0] ?? null;
        });
      }
      case "file": {
        if (op.type !== "file") return flag("Upload the file manually");
        const meta = deps.documents.find((d) => d.id === op.documentId);
        if (!meta) return flag("Document not found");
        const doc = compatibleDoc(meta, deps.documents, h.desc.accept);
        if (!doc) return flag(`No uploaded file matches ${h.desc.accept}`);
        const data = await deps.getDocument(doc.id);
        return data ? fillFile(h, data.meta, data.base64) : flag("Document not found");
      }
    }
  } catch (e) {
    return { outcome: "failed", note: (e as Error).message };
  }
}
