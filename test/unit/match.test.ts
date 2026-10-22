import { beforeAll, describe, expect, it } from "vitest";
import { localMatch, localMatchAll } from "../../src/content/match/localMatch";
import { deterministicValue, formatPhone, matchLearned } from "../../src/content/match/deterministic";
import { fitLength, formatDateFor } from "../../src/content/fill/native";
import { emptyProfile } from "../../src/shared/profileSchema";
import type { FieldDescriptor } from "../../src/shared/types";
import { stubLayout } from "./dom";

beforeAll(stubLayout);

describe("localMatch (§13.3)", () => {
  it("returns null for the relocation trap — that goes to the AI", () => {
    expect(localMatch("yes", ["I am willing to relocate", "I am not willing to relocate"])).toBeNull();
    expect(localMatch("Yes", ["I will not require sponsorship", "I will require sponsorship"])).toBeNull();
  });
  it("matches exact normalized text, only when unique", () => {
    expect(localMatch("yes", ["Yes", "No"])).toBe(0);
    expect(localMatch("  NO!", ["Yes", "No"])).toBe(1);
    expect(localMatch("Yes", ["Yes", "yes"])).toBeNull();
  });
  it("matches country and region aliases", () => {
    expect(localMatch("USA", ["Canada", "United States", "Mexico"])).toBe(1);
    expect(localMatch("BC", ["Alberta", "British Columbia", "Ontario"])).toBe(1);
    expect(localMatch("Canada", ["CA", "US"])).toBe(0);
  });
  it("never resolves yes/no to a country code", () => {
    expect(localMatch("No", ["Norway", "Sweden"])).toBeNull();
  });
  it("matches numeric and date equivalents", () => {
    expect(localMatch("2027", ["2026", "2027", "2028"])).toBe(1);
    expect(localMatch("May 2027", ["2027-04", "2027-05"])).toBe(1);
    expect(localMatch("2027-05", ["April 2027", "May 2027"])).toBe(1);
  });
  it("never does substring or fuzzy matching", () => {
    expect(localMatch("relocate", ["I am willing to relocate"])).toBeNull();
    expect(localMatch("Python", ["Python 3", "Java"])).toBeNull();
  });
  it("multi-value answers need every part to match", () => {
    expect(localMatchAll("Python | Go", ["Go", "Python", "Rust"])).toEqual([1, 0]);
    expect(localMatchAll("Python | Zig", ["Go", "Python"])).toBeNull();
  });
});

const f = (label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: "f1",
  kind: "text",
  label,
  required: false,
  optionsKnown: true,
  ...extra,
});

describe("deterministic matching (§13.2)", () => {
  const p = emptyProfile().personal;
  Object.assign(p, { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" });
  p.phone = { countryCode: "+1", number: "6045551234", type: "mobile" };
  p.address.region = "British Columbia";
  p.address.regionCode = "BC";
  p.links.linkedin = "https://linkedin.com/in/ada";

  it("maps autocomplete tokens", () => {
    expect(deterministicValue(f("Given", { autocomplete: "given-name" }), p)?.value).toBe("Ada");
    expect(deterministicValue(f("x", { autocomplete: "section-a shipping family-name" }), p)?.value).toBe("Lovelace");
    expect(deterministicValue(f("x", { autocomplete: "address-level1", maxLength: 2 }), p)?.value).toBe("BC");
    expect(deterministicValue(f("x", { autocomplete: "tel", kind: "tel" }), p)?.value).toBe("+1 6045551234");
  });
  it("maps unambiguous label regexes", () => {
    expect(deterministicValue(f("First name"), p)).toEqual({ value: "Ada", path: "personal.firstName" });
    expect(deterministicValue(f("Full name"), p)?.value).toBe("Ada Lovelace");
    expect(deterministicValue(f("Email address", { kind: "email" }), p)?.value).toBe("ada@example.com");
    expect(deterministicValue(f("LinkedIn profile"), p)?.value).toBe("https://linkedin.com/in/ada");
    expect(deterministicValue(f("Province / State"), p)?.value).toBe("British Columbia");
    // Lever: "Name Pronunciation | How do you pronounce your name?" is not a pronouns question.
    expect(deterministicValue(f("Name Pronunciation | How do you pronounce your name?"), p)).toBeNull();
    // Stripe: a Canadian resident must not answer a US-only question with their province.
    expect(deterministicValue(f("If located in the US, in what city and state do you reside?"), p)).toBeNull();
  });
  it("answers city and location typeaheads with the full place, searched by city", () => {
    const q = { ...p, address: { ...p.address, city: "Langley", region: "British Columbia", country: "Canada" } };
    const loc = { value: "Langley, British Columbia, Canada", path: "personal.address.city + region + country" };
    expect(deterministicValue(f("Current Location", { kind: "typeahead" }), q)).toEqual({ ...loc, query: "Langley" });
    expect(deterministicValue(f("City", { kind: "typeahead" }), q)).toEqual({ ...loc, query: "Langley" });
    expect(deterministicValue(f("Location (City)"), q)?.value).toBe(loc.value);
    expect(deterministicValue(f("Office location", { kind: "typeahead" }), q)).toBeNull();
    expect(deterministicValue(f("School", { kind: "typeahead" }), q)).toBeNull();
  });
  it("returns empty values for recognized fields unset in the profile", () => {
    expect(deterministicValue(f("GitHub"), p)).toEqual({ value: "", path: "personal.links.github" });
    expect(deterministicValue(f("Address 1"), p)).toEqual({ value: "", path: "personal.address.line1" });
    expect(deterministicValue(f("Phone", { kind: "tel" }), { ...p, phone: { ...p.phone, number: "" } })?.value).toBe(
      "",
    );
  });
  it("skips ambiguous labels and non-text kinds", () => {
    expect(deterministicValue(f("City, State"), p)).toBeNull();
    expect(deterministicValue(f("Personal statement", { kind: "textarea" }), p)).toBeNull();
    expect(deterministicValue(f("First name", { kind: "select" }), p)).toBeNull();
  });
  it("formats phones per the placeholder", () => {
    expect(deterministicValue(f("Phone", { kind: "tel", placeholder: "(555) 555-5555" }), p)?.value).toBe(
      "(604) 555-1234",
    );
    expect(formatPhone("+1 604 555 1234", "###-###-####")).toBe("604-555-1234");
    expect(formatPhone("6045551234", "Phone")).toBe("6045551234");
  });
  it("matches learned answers by normalized question and compatible kind", () => {
    const learned = [
      {
        id: "1",
        question: "Are you 18+?",
        normalizedQuestion: "are you 18+",
        kind: "radio_group" as const,
        answer: "Yes",
      },
    ];
    expect(matchLearned(f("Are you 18+ ?", { kind: "select" }), learned)?.id).toBe("1");
    expect(matchLearned(f("Are you 18+?", { kind: "text" }), learned)).toBeNull();
  });
});

describe("fill formatting (§14.2, §14.3)", () => {
  const input = (type: string, placeholder = "") =>
    Object.assign(document.createElement("input"), { type, placeholder });
  it("converts ISO dates to input types and placeholder formats", () => {
    expect(formatDateFor(input("date"), "2027-05")).toBe("2027-05-01");
    expect(formatDateFor(input("month"), "05/2027")).toBe("2027-05");
    expect(formatDateFor(input("text", "MM/DD/YYYY"), "2027-05-03")).toBe("05/03/2027");
    expect(formatDateFor(input("text", "DD-MM-YYYY"), "2027-05-03")).toBe("03-05-2027");
    expect(formatDateFor(input("text", "MM/YYYY"), "2027-05")).toBe("05/2027");
    expect(formatDateFor(input("text"), "2027-05-03")).toBe("2027-05-03");
    // react-datepicker (Ashby) reads ISO as UTC (a day early in the Americas): use its MM/DD/YYYY default.
    const wrap = document.createElement("div");
    wrap.className = "react-datepicker__input-container";
    const picker = wrap.appendChild(input("text", "Pick date..."));
    expect(formatDateFor(picker, "2028-05")).toBe("05/01/2028");
  });
  it("truncates to maxLength at a word boundary", () => {
    expect(fitLength("hello wonderful world", 15)).toBe("hello wonderful");
    expect(fitLength("one two three four", 10)).toBe("one two");
    expect(fitLength("short", 15)).toBe("short");
  });
});
