import { useEffect, useState } from "preact/hooks";
import { AI } from "./routes/AI";
import { Applications } from "./routes/Applications";
import { Behavior } from "./routes/Behavior";
import { Data } from "./routes/Data";
import { Documents, useResumeTexts } from "./routes/Documents";
import { Profile } from "./routes/Profile";
import { SavedAnswers } from "./routes/SavedAnswers";
import { Setup } from "./routes/Setup";
import { Yolo } from "./routes/Yolo";
import { onSaved, useHash } from "./store";

const NAV: [string, string][] = [
  ["/setup", "Setup"],
  ["/profile", "Profile"],
  ["/documents", "Documents"],
  ["/saved", "Saved Answers"],
  ["/ai", "AI"],
  ["/behavior", "Behavior"],
  ["/yolo", "YOLO Mode"],
  ["/applications", "Applications"],
  ["/data", "Data"],
];

function SavedIndicator() {
  const [at, setAt] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => onSaved(setAt), []);
  useEffect(() => {
    if (!at) return;
    const t = setTimeout(() => tick((n) => n + 1), 1600);
    return () => clearTimeout(t);
  }, [at]);
  return (
    <span class={`saved ${Date.now() - at < 1500 ? "show" : ""}`} role="status" aria-live="polite">
      {Date.now() - at < 1500 ? "Saved" : ""}
    </span>
  );
}

export function App() {
  const hash = useHash();
  useResumeTexts();
  const [, section = "setup", sub = ""] = hash.split("/");
  let page;
  switch (section) {
    case "profile":
      page = <Profile group={sub || "personal"} />;
      break;
    case "documents":
      page = <Documents />;
      break;
    case "saved":
      page = <SavedAnswers />;
      break;
    case "ai":
      page = <AI />;
      break;
    case "behavior":
      page = <Behavior />;
      break;
    case "data":
      page = <Data />;
      break;
    case "yolo":
      page = <Yolo />;
      break;
    case "applications":
      page = <Applications />;
      break;
    default:
      page = <Setup step={Number(sub) || 1} />;
  }
  return (
    <div class="layout">
      <aside>
        <div class="brand">
          <img src="/icons/48.png" alt="" width={28} height={28} /> AutoApply
        </div>
        <nav aria-label="Settings sections">
          {NAV.map(([href, text]) => (
            <a href={`#${href}`} aria-current={`/${section}` === href ? "page" : undefined}>
              {text}
            </a>
          ))}
        </nav>
        <SavedIndicator />
      </aside>
      <main>{page}</main>
    </div>
  );
}
