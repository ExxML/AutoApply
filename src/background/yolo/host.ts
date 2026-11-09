// Where YOLO loads job pages: an iframe in an offscreen document (nothing on screen), else a background tab.
import { compiling, releaseOffscreen, useOffscreen } from "../offscreen";

const RULE = 9001;

/**
 * Lets sites load inside the offscreen document's frame: their X-Frame-Options / CSP frame-ancestors forbid
 * embedding. Limited to frames outside any tab, i.e. ours, and only while the host is open.
 */
const unframeRule = (): chrome.declarativeNetRequest.Rule => ({
  id: RULE,
  priority: 1,
  action: {
    type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
    responseHeaders: ["x-frame-options", "content-security-policy"].map((header) => ({
      header,
      operation: "remove" as chrome.declarativeNetRequest.HeaderOperation,
    })),
  },
  condition: {
    tabIds: [chrome.tabs.TAB_ID_NONE],
    resourceTypes: ["sub_frame" as chrome.declarativeNetRequest.ResourceType],
  },
});

export async function openFrame(url: string) {
  // Also when the document is already open: a résumé compile may have opened it, without the rule.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE], addRules: [unframeRule()] });
  await useOffscreen("yolo");
  await chrome.runtime.sendMessage({ type: "YOLO_HOST_NAVIGATE", url });
}

/** Frees the hidden page's renderer once the queue is empty (a compile in progress keeps the document, not the page). */
export async function closeFrame() {
  if (compiling()) await chrome.runtime.sendMessage({ type: "YOLO_HOST_CLEAR" }).catch(() => undefined);
  await releaseOffscreen("yolo");
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE] });
}

/** A tab for pages that won't work hidden (inactive, in an "AutoApply" group), or a visible one for the user. */
export async function openTab(url: string, visible: boolean): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: visible });
  if (!visible && tab.id !== undefined) {
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    // Not collapsed: Chrome freezes a collapsed group's tabs within seconds (tab.frozen), stopping the page's own
    // scripts mid-application (Greenhouse's school search never answered).
    await chrome.tabGroups.update(groupId, { title: "AutoApply", collapsed: false });
  }
  return tab.id!;
}

export const closeTab = (id: number) => chrome.tabs.remove(id).catch(() => undefined);
