// Offscreen document: holds the one frame YOLO applies in. The content script inside drives the page itself.
import type { Message } from "../shared/messages";

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type !== "YOLO_HOST_NAVIGATE") return false;
  let f = document.querySelector("iframe");
  if (!f) {
    // A desktop-sized viewport, so sites lay out their full forms rather than mobile steps.
    f = Object.assign(document.createElement("iframe"), { name: "autoapply-yolo" });
    f.style.cssText = "width:1366px;height:900px;border:0";
    f.allow = "clipboard-write";
    document.body.append(f);
  }
  f.src = msg.url;
  sendResponse({ ok: true });
  return false;
});
