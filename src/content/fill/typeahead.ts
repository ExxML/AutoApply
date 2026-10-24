// §14.6 typeahead: type, wait for suggestions, pick by safe local match or the AI.
import { collapse, normalize } from "../../shared/normalize";
import { localMatch } from "../match/localMatch";
import type { FieldHandle } from "../scan/fields";
import {
  busy,
  closeDropdown,
  findOptionsContainer,
  optText,
  optionElements,
  PAGE_MAX_MS,
  settle,
  snapshot,
  submitSearch,
} from "./dropdown";
import { blur, focus, key, realClick, setNativeValue, sleep, typeText, waitFor } from "./events";
import type { FillResult } from "./native";
import { dropdownText, sameValue } from "./verify";

/** The pick a combobox shows beside its emptied search box: react-select's single value (Epic Games). */
function shownBeside(input: HTMLElement): string {
  let p = input.parentElement;
  for (let i = 0; i < 4 && p && !p.querySelector("label"); i++, p = p.parentElement) {
    const clone = p.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('input,svg,script,style,[aria-live],[class*="placeholder" i],[class*="a11y" i]')
      .forEach((n) => n.remove());
    const t = collapse(clone.textContent ?? "");
    if (t) return t;
  }
  return "";
}

export async function fillTypeahead(
  h: FieldHandle,
  query: string,
  intended: string,
  choose: (options: string[]) => Promise<number | null>,
): Promise<FillResult> {
  const input = (h.searchInput ?? h.el) as HTMLInputElement;
  if (normalize(input.value) && normalize(input.value) === normalize(intended))
    return { outcome: "ok", shown: input.value };
  let typed = query || intended;
  const suggest = async () => {
    const before = snapshot();
    focus(input);
    setNativeValue(input, "");
    await typeText(input, typed);
    if (h.searchInput) submitSearch(input);
    let c = await waitFor(() => findOptionsContainer(h, before), 2000);
    // A slow suggestion search (Lever's location lookup) shows its spinner meanwhile: wait it out.
    if (!c && busy([h.container])) {
      await waitFor(() => findOptionsContainer(h, before) || !busy([h.container]), PAGE_MAX_MS);
      c = findOptionsContainer(h, before);
    }
    if (c) await settle(c);
    return c;
  };
  let c = await suggest();
  // A place search may find nothing for "Vancouver, BC" and plenty for "Vancouver" (SmartRecruiters).
  const head = typed.split(",")[0].trim();
  const lists = (box: HTMLElement | null) =>
    !!box && optionElements(box).some((o) => normalize(optText(o)).includes(normalize(head)));
  if (head !== typed.trim() && !lists(c)) {
    // Closed first, so the reopened list reads as new.
    await closeDropdown(h, c);
    typed = head;
    c = await suggest();
  }
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
  const q = normalize(typed);
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
  const v = normalize(input.value || h.el.textContent || shownBeside(input));
  // Our own query left in the box ("Langley" of "Langley, BC") means the pick did not register.
  const picked = v.includes(normalize(want)) || (normalize(want).includes(v) && v !== normalize(typed));
  return v && picked
    ? { outcome: "ok", shown: want }
    : { outcome: "mismatch", note: `Expected "${want}", shows "${input.value}"` };
}
