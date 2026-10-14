import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./chromeMock";
import { cleanLabel, humanize, normalize } from "../../src/shared/normalize";
import { canonicalCountry, canonicalRegion, regionCode } from "../../src/shared/constants";
import { canonicalJson, hash } from "../../src/shared/hash";
import { nextMidnightPacific } from "../../src/shared/time";
import { createStorage, profileVersionOf } from "../../src/shared/storage";
import { emptyProfile, ProfileSchema } from "../../src/shared/profileSchema";
import { defaultSettings } from "../../src/shared/settings";

describe("normalize", () => {
  it("strips diacritics, lowercases, maps & and drops punctuation except + and #", () => {
    expect(normalize("  Résumé & CV!!  ")).toBe("resume and cv");
    expect(normalize("C++ / C#")).toBe("c++ c#");
    expect(normalize("Québec,   Canada.")).toBe("quebec canada");
    expect(normalize("I don't wish to answer")).toBe("i dont wish to answer");
  });
  it("humanizes names and cleans labels", () => {
    expect(humanize("firstName")).toBe("first name");
    expect(humanize("applicant[first_name]")).toBe("applicant first name");
    expect(cleanLabel("First name *")).toBe("First name");
    expect(cleanLabel("Phone (optional)")).toBe("Phone");
    expect(cleanLabel("Is a visa required")).toBe("Is a visa required");
  });
});

describe("alias tables", () => {
  it("resolves countries by ISO-2, ISO-3 and common names", () => {
    const us = canonicalCountry("United States");
    expect(us).toBeTruthy();
    for (const a of ["US", "usa", "USA", "United States of America", "u.s."]) expect(canonicalCountry(a)).toBe(us);
    expect(canonicalCountry("CAN")).toBe(canonicalCountry("Canada"));
    expect(canonicalCountry("UK")).toBe(canonicalCountry("GBR"));
    expect(canonicalCountry("Côte d’Ivoire")).toBe(canonicalCountry("Ivory Coast"));
    expect(canonicalCountry("Atlantis")).toBeNull();
  });
  it("resolves Canadian and US regions", () => {
    expect(canonicalRegion("BC")).toBe("british columbia");
    expect(canonicalRegion("British Columbia")).toBe("british columbia");
    expect(canonicalRegion("Québec")).toBe("quebec");
    expect(canonicalRegion("ny")).toBe("new york");
    expect(regionCode("Ontario")).toBe("ON");
  });
});

describe("hash", () => {
  it("is FNV-1a base36 and stable", () => {
    expect(hash("")).toBe((0x811c9dc5).toString(36));
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
  });
  it("canonicalJson sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

describe("nextMidnightPacific", () => {
  const laHour = (ts: number) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).format(ts);
  it("returns 00:00 Los Angeles time during PDT (UTC-7)", () => {
    const now = Date.UTC(2026, 6, 15, 18, 0); // 11:00 PDT
    const t = nextMidnightPacific(now);
    expect(t).toBe(Date.UTC(2026, 6, 16, 7, 0));
    expect(laHour(t)).toBe("00:00");
  });
  it("returns 00:00 Los Angeles time during PST (UTC-8)", () => {
    expect(nextMidnightPacific(Date.UTC(2026, 0, 10, 12, 0))).toBe(Date.UTC(2026, 0, 11, 8, 0));
  });
  it("handles the day DST starts and the day it ends", () => {
    // DST starts 2026-03-08 02:00 PST → next midnight is 2026-03-09 00:00 PDT = 07:00Z
    expect(nextMidnightPacific(Date.UTC(2026, 2, 8, 9, 0))).toBe(Date.UTC(2026, 2, 9, 7, 0));
    // Evening before DST starts (PST) → midnight 2026-03-08 00:00 PST = 08:00Z
    expect(nextMidnightPacific(Date.UTC(2026, 2, 8, 5, 0))).toBe(Date.UTC(2026, 2, 8, 8, 0));
    // DST ends 2026-11-01 02:00 PDT → next midnight is 2026-11-02 00:00 PST = 08:00Z
    expect(nextMidnightPacific(Date.UTC(2026, 10, 1, 12, 0))).toBe(Date.UTC(2026, 10, 2, 8, 0));
  });
  it("just after midnight returns the following midnight", () => {
    expect(nextMidnightPacific(Date.UTC(2026, 6, 16, 7, 0, 1))).toBe(Date.UTC(2026, 6, 17, 7, 0));
  });
});

describe("storage", () => {
  beforeEach(() => installChromeMock());

  it("falls back to defaults on missing or invalid data, keeping valid leaves", async () => {
    const store = createStorage("background");
    expect(await store.get("settings")).toEqual(defaultSettings());
    await chrome.storage.local.set({ settings: { draftEssays: "nope", essayDefaultWords: 200 } });
    const s = await store.get("settings");
    expect(s.draftEssays).toBe(true);
    expect(s.essayDefaultWords).toBe(200);
    await chrome.storage.local.set({ profile: { personal: { firstName: "Ada", email: 42 } } });
    const p = await store.get("profile");
    expect(p.personal.firstName).toBe("Ada");
    expect(p.personal.email).toBe("");
    expect(p.education).toEqual([]);
  });

  it("enforces the per-context allow-list (popup cannot read apiKeys)", async () => {
    const popup = createStorage("popup");
    await expect(popup.get("apiKeys")).rejects.toThrow(/not allowed/);
    await expect(popup.get("settings")).resolves.toBeTruthy();
  });

  it("profileVersion ignores learnedAnswers.lastUsedAt but tracks everything else", () => {
    const p = emptyProfile();
    p.learnedAnswers = [
      {
        id: "1",
        question: "Q",
        normalizedQuestion: "q",
        kind: "text",
        answer: "A",
        host: "h",
        createdAt: 1,
        lastUsedAt: 1,
      },
    ];
    const v1 = profileVersionOf(p);
    p.learnedAnswers[0].lastUsedAt = 999;
    expect(profileVersionOf(p)).toBe(v1);
    p.personal.firstName = "Ada";
    expect(profileVersionOf(p)).not.toBe(v1);
  });

  it("drops invalid learned answers", () => {
    const p = ProfileSchema.parse({
      learnedAnswers: [{ bad: true }, { id: "x", question: "q", normalizedQuestion: "q", kind: "text", answer: "a" }],
    });
    expect(p.learnedAnswers).toHaveLength(1);
  });
});
