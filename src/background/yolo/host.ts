// Where YOLO loads job pages: an iframe in an offscreen document (nothing on screen), else a background tab.
const OFFSCREEN = "src/offscreen/index.html";
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
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE], addRules: [unframeRule()] });
    await chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ["IFRAME_SCRIPTING" as chrome.offscreen.Reason],
      justification: "Applies to jobs in a hidden frame while YOLO mode is on.",
    });
  }
  await chrome.runtime.sendMessage({ type: "YOLO_HOST_NAVIGATE", url });
}

/** Frees the hidden page's renderer once the queue is empty. */
export async function closeFrame() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE] });
}

/** A tab for pages that won't work hidden (inactive, in a collapsed group), or a visible one for the user. */
export async function openTab(url: string, visible: boolean): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: visible });
  if (!visible && tab.id !== undefined) {
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(groupId, { title: "AutoApply", collapsed: true });
  }
  return tab.id!;
}

export const closeTab = (id: number) => chrome.tabs.remove(id).catch(() => undefined);
