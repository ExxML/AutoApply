// §14.6 typeahead: type, wait for suggestions, pick by safe local match or the AI.
import { normalize } from "../../shared/normalize";
import { localMatch } from "../match/localMatch";
import type { FieldHandle } from "../scan/fields";
import {
  closeDropdown,
  findOptionsContainer,
  optText,
  optionElements,
  settle,
  snapshot,
  submitSearch,
} from "./dropdown";
import { blur, focus, key, realClick, setNativeValue, sleep, typeText, waitFor } from "./events";
import type { FillResult } from "./native";
import { dropdownText, sameValue } from "./verify";

export async function fillTypeahead(
  h: FieldHandle,
  query: string,
  intended: string,
  choose: (options: string[]) => Promise<number | null>,
): Promise<FillResult> {
  const input = (h.searchInput ?? h.el) as HTMLInputElement;
  if (normalize(input.value) && normalize(input.value) === normalize(intended))
    return { outcome: "ok", shown: input.value };
  const suggest = async () => {
    const before = snapshot();
    focus(input);
    setNativeValue(input, "");
    await typeText(input, query || intended);
    if (h.searchInput) submitSearch(input);
    const c = await waitFor(() => findOptionsContainer(h, before), 2000);
    if (c) await settle(c);
    return c;
  };
  const c = await suggest();
  if (!c) {
    // A dropdown's search box only filters its list: text left there selects nothing.
    if (h.desc.kind === "dropdown") {
      setNativeValue(input, "");
      key(input, "Escape");
    }
    blur(input);
    await sleep(50);
    return input.value
      ? { outcome: "ok", shown: input.value, note: "No suggestion list; typed value" }
      : { outcome: "flag", note: "No suggestions appeared" };
  }
  const els = optionElements(c);
  const texts = els.map(optText);
  const q = normalize(query || intended);
  let i = localMatch(intended, texts);
  if (i === null && texts.length === 1 && normalize(texts[0]).startsWith(q)) i = 0;
  if (i === null) i = await choose(texts);
  if (i === null || !els[i]) {
    await closeDropdown(h, c);
    return { outcome: "flag", note: `No suggestion matched "${intended}"` };
  }
  const want = texts[i];
  let el: HTMLElement | undefined = els[i];
  // The AI takes seconds to choose; another fill taking focus meanwhile closes the list, detaching the option.
  if (!el.isConnected || optText(el) !== want) {
    const again = await suggest();
    el = again ? optionElements(again).find((o) => optText(o) === want) : undefined;
    if (!el) {
      await closeDropdown(h, again);
      blur(input);
      return { outcome: "failed", note: `Could not select "${want}"` };
    }
  }
  realClick(el);
  await sleep(40);
  blur(input);
  // A dropdown's search box empties once an option is picked; the widget shows the pick.
  if (h.desc.kind === "dropdown")
    return sameValue(want, dropdownText(h), "contains")
      ? { outcome: "ok", shown: want }
      : { outcome: "mismatch", note: `Expected "${want}", shows "${dropdownText(h)}"` };
  const v = normalize(input.value || h.el.textContent || "");
  return v && (v.includes(normalize(want)) || normalize(want).includes(v))
    ? { outcome: "ok", shown: want }
    : { outcome: "mismatch", note: `Expected "${want}", shows "${input.value}"` };
}
