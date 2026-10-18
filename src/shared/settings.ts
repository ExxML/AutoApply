import { z } from "zod";

const b = (d: boolean) => z.boolean().catch(d);
const n = (d: number, min: number, max: number) => z.number().int().min(min).max(max).catch(d);

const base = z.object({
  overwritePrefilled: b(false),
  autoAcceptAcknowledgements: b(false),
  optionalConsents: z.enum(["ask", "accept", "decline"]).catch("ask"),
  draftEssays: b(true),
  essayDefaultWords: n(150, 10, 2000),
  coverLetterDefaultWords: n(300, 10, 2000),
  showBadges: b(true),
  learnPrompts: b(true),
  excludedHosts: z.array(z.string()).catch([]),
  maxFieldsPerRequest: n(40, 1, 200),
  requestTimeoutMs: n(25000, 1000, 120000),
  maxConcurrentRequests: n(4, 1, 16),
  debugLogging: b(false),
});

export const SettingsSchema = base.catch(() => base.parse({}));
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings = (): Settings => SettingsSchema.parse({});
