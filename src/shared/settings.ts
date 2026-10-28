import { z } from "zod";
import { MAX_DAILY_APPLICATIONS } from "./yolo";

const b = (d: boolean) => z.boolean().catch(d);
const n = (d: number, min: number, max: number) => z.number().int().min(min).max(max).catch(d);

/** What the Claude bridge passes on claude's command line as a model or effort (src/native). */
export const CLAUDE_ARG = /^[a-z0-9.-]{0,32}$/;

/** A Claude Code model (an alias or id from its model list) and effort level; "": Claude Code's own default. */
const claudeTask = z
  .object({
    model: z.string().regex(CLAUDE_ARG).catch(""),
    effort: z.enum(["", "low", "medium", "high", "xhigh", "max"]).catch(""),
  })
  .catch({ model: "", effort: "" });
const claudeTasks = z.object({ fill: claudeTask, write: claudeTask, resume: claudeTask });

const base = z.object({
  /** Gemini with API keys, or Claude through the user's own Claude Code and plan (background/claude). */
  aiProvider: z.enum(["gemini", "claude"]).catch("gemini"),
  /** Per task: fill = autofill and YOLO's relevance check, write = essays and cover letters, resume = résumé import. */
  claude: claudeTasks.catch(() => claudeTasks.parse({})),
  overwritePrefilled: b(false),
  autoAcceptAcknowledgements: b(true),
  optionalConsents: z.enum(["ask", "accept", "decline"]).catch("decline"),
  draftEssays: b(true),
  essayDefaultWords: n(150, 10, 2000),
  coverLetterDefaultWords: n(300, 10, 2000),
  /** If no cover letter is uploaded in Documents, generate a tailored cover letter. YOLO sets its own. */
  coverLetterPdfs: b(false),
  showBadges: b(true),
  learnPrompts: b(false),
  excludedHosts: z.array(z.string()).catch([]),
  maxFieldsPerRequest: n(40, 1, 200),
  requestTimeoutMs: n(25000, 1000, 120000),
  maxConcurrentRequests: n(4, 1, 16),
  debugLogging: b(false),
  /** How many YOLO applications' debug logs are kept. */
  debugLogLimit: n(25, 1, MAX_DAILY_APPLICATIONS),
});

export const SettingsSchema = base.catch(() => base.parse({}));
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings = (): Settings => SettingsSchema.parse({});
export type AiTask = keyof Settings["claude"];
export type ClaudeTask = Settings["claude"][AiTask];
