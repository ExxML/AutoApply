import { useEffect, useState } from "preact/hooks";
import { NumberInput, TagInput, TextInput, Toggle } from "../components/controls";
import { save, useStored } from "../store";
import { isErr, send, type Responses } from "../../shared/messages";
import { formatDateTime } from "../../shared/time";
import { BOARDS, type Board, type Yolo as YoloConfig } from "../../shared/yolo";

const BOARD_NAMES: Record<Board, string> = { linkedin: "LinkedIn", indeed: "Indeed", glassdoor: "Glassdoor" };

function Accounts() {
  const [rows, setRows] = useState<Responses["YOLO_ACCOUNTS"]>([]);
  const [shown, setShown] = useState<Record<string, string>>({});
  const load = () => void send({ type: "YOLO_ACCOUNTS" }).then(setRows);
  useEffect(load, []);
  if (!rows.length) return <p class="muted">None yet. YOLO creates one when a site requires it (Workday does).</p>;
  return (
    <table class="table">
      <thead>
        <tr>
          <th>Site</th>
          <th>Email</th>
          <th>Created</th>
          <th>Password</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr>
            <td>{a.site}</td>
            <td>{a.email}</td>
            <td class="muted">{formatDateTime(a.createdAt)}</td>
            <td>
              {shown[a.site] ? (
                <code>{shown[a.site]}</code>
              ) : (
                <button
                  type="button"
                  class="btn small"
                  onClick={async () => {
                    const r = await send({ type: "YOLO_REVEAL", site: a.site });
                    setShown({ ...shown, [a.site]: isErr(r) ? r.error.message : r.password });
                  }}
                >
                  Reveal
                </button>
              )}
            </td>
            <td>
              <button
                type="button"
                class="btn small danger"
                onClick={() => void send({ type: "YOLO_DELETE_ACCOUNT", site: a.site }).then(load)}
              >
                Forget
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Gmail(props: { y: YoloConfig; set: (p: Partial<YoloConfig>) => void }) {
  const state = useStored("yoloState");
  const [msg, setMsg] = useState("");
  const redirect = chrome.identity?.getRedirectURL() ?? "";
  return (
    <div class="field wide">
      <TextInput
        label="Gmail OAuth client ID"
        value={props.y.gmailClientId}
        onInput={(v) => props.set({ gmailClientId: v.trim() })}
        placeholder="1234-abc.apps.googleusercontent.com"
        help="Lets YOLO read verification emails sent to the YOLO email (read-only). Without it, emailed codes are read from the Gmail inbox signed in to this browser; sites that email a link are left for you."
      />
      <details class="help">
        <summary>Set up the client ID (once, about 5 minutes)</summary>
        <ol>
          <li>In Google Cloud Console, create a project and enable the Gmail API.</li>
          <li>OAuth consent screen: External; add the YOLO email as a test user.</li>
          <li>
            Credentials → Create OAuth client ID → Web application, with this authorized redirect URI:{" "}
            <code>{redirect}</code>
          </li>
          <li>Paste the client ID above, then press Connect and sign in with the YOLO email.</li>
          <li>If this extension's folder moves, its redirect URI changes: update it in the client.</li>
        </ol>
      </details>
      <div class="row">
        <button
          type="button"
          class="btn"
          disabled={!props.y.gmailClientId}
          onClick={async () => {
            const r = await send({ type: "YOLO_GMAIL_CONNECT" });
            setMsg(isErr(r) ? r.error.message : "Connected.");
          }}
        >
          Connect Gmail
        </button>{" "}
        <span class={state?.gmailNeedsAuth ? "err" : "muted"} role="status">
          {msg || (state?.gmailNeedsAuth ? "Gmail needs to be reconnected." : "")}
        </span>
      </div>
    </div>
  );
}

export function Yolo() {
  const y = useStored("yolo");
  if (!y) return <p>Loading…</p>;
  const set = (patch: Partial<YoloConfig>) => void save({ yolo: { ...y, ...patch } });
  const urls = (v: string[]) => v.filter((u) => /^https?:\/\//i.test(u));
  return (
    <section class="yolo">
      <h1>YOLO mode</h1>
      <p class="intro">
        While on, AutoApply checks your searches on a timer and applies to new matching jobs by itself: it creates site
        accounts when needed, fills every field (with its best guess where your profile has no answer), and submits. It
        works in a hidden page, so nothing opens on screen. Everything it does is listed under Applications, with the
        answers it guessed.
      </p>
      <h2>Mode</h2>
      <div class="form">
        <Toggle
          label="YOLO mode"
          help={y.queries.length ? "Also in the toolbar popup." : "Add a search query below first."}
          checked={y.enabled}
          onChange={(enabled) => void send({ type: "YOLO_SET", enabled })}
        />
        <NumberInput
          label="Check every (minutes)"
          value={y.intervalMin}
          min={5}
          max={1440}
          onChange={(intervalMin) => set({ intervalMin })}
        />
        <NumberInput
          label="Applications per day"
          help="0 finds and queues jobs without applying (a dry run)."
          value={y.dailyCap}
          min={0}
          max={500}
          onChange={(dailyCap) => set({ dailyCap })}
        />
      </div>
      <h2>Search</h2>
      <div class="form">
        <TagInput
          label="Search queries"
          help='A job matches a query when its title contains every word of it, in any order (plurals and synonyms count: "intern" matches "Internship" and "Co-op"). A job needs to match only one query, so add one query per role, e.g. "software intern" and "data intern". Each query is searched separately on every job board.'
          value={y.queries}
          onChange={(queries) => set({ queries })}
        />
        <TagInput
          label="Locations"
          help="Countries, provinces or cities, e.g. Canada, Seattle. Empty: anywhere."
          value={y.locations}
          onChange={(locations) => set({ locations })}
        />
        <Toggle label="Include remote jobs" checked={y.remoteOk} onChange={(remoteOk) => set({ remoteOk })} />
        <NumberInput
          label="Posted within (days)"
          value={y.postedWithinDays}
          min={1}
          max={90}
          onChange={(postedWithinDays) => set({ postedWithinDays })}
        />
        <TagInput
          label="Skip titles with"
          value={y.excludeTitleWords}
          onChange={(excludeTitleWords) => set({ excludeTitleWords })}
        />
        <TagInput label="Skip companies" value={y.skipCompanies} onChange={(skipCompanies) => set({ skipCompanies })} />
        <Toggle
          label="Check matches with AI"
          help="One Gemini call per check drops jobs whose level or requirements rule you out (PhD-only, citizens only)."
          checked={y.aiRelevanceCheck}
          onChange={(aiRelevanceCheck) => set({ aiRelevanceCheck })}
        />
      </div>
      <h2>Sources</h2>
      <div class="form">
        <div>
          {BOARDS.map((b) => (
            <Toggle
              label={BOARD_NAMES[b]}
              help={b === "indeed" ? "Indeed loads its results with scripts, so they're read from a hidden browser page. Slower than the other sources." : undefined}
              checked={y.boards.includes(b)}
              onChange={(on) => set({ boards: on ? [...y.boards, b] : y.boards.filter((x) => x !== b) })}
            />
          ))}
        </div>
        <TagInput
          label="GitHub job lists"
          help="Raw URLs of a listings.json (SimplifyJobs format) or a README with a job table."
          value={y.feeds}
          onChange={(v) => set({ feeds: urls(v) })}
        />
        <TagInput
          label="Company career sites"
          help='Enter the exact page that lists jobs, not a homepage. Workday, Greenhouse, Lever, Ashby and SmartRecruiters board URLs are read through their APIs. Any other page is opened once in a hidden page and its job links are read off it; it does not click through or page. For those, use a search results URL, with "{q}" where the query goes (e.g. https://jobs.example.com/search?q={q}).'
          value={y.careerSites}
          onChange={(v) => set({ careerSites: urls(v) })}
        />
      </div>
      <h2>Applying</h2>
      <div class="form">
        <TextInput
          label="YOLO email"
          type="email"
          value={y.email}
          onInput={(email) => set({ email: email.trim() })}
          help="Used for site accounts and on applications YOLO sends. Empty: your profile's email."
        />
        <Gmail y={y} set={set} />
        <Toggle
          label="Retry in a background tab"
          help="Sites that refuse to work hidden are retried in an inactive tab (in a collapsed “AutoApply” group), closed when done."
          checked={y.tabFallback}
          onChange={(tabFallback) => set({ tabFallback })}
        />
      </div>
      <h2>Already applied</h2>
      <div class="form">
        <Toggle
          label="Re-apply to jobs I submitted myself"
          help="Off: YOLO skips jobs you applied to after an AutoApply fill."
          checked={y.reapplyManual}
          onChange={(reapplyManual) => set({ reapplyManual })}
        />
        <Toggle
          label="Warn me on jobs YOLO applied to"
          help="When you fill a posting YOLO already submitted, the AutoApply panel says so."
          checked={y.warnOnYoloApplied}
          onChange={(warnOnYoloApplied) => set({ warnOnYoloApplied })}
        />
      </div>
      <h2>Site accounts</h2>
      <p class="intro">
        Passwords are encrypted with a key that never leaves this browser, and not included in exports.
      </p>
      <Accounts />
    </section>
  );
}
