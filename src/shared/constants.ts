import { normalize } from "./normalize";

// ---------- Gemini ----------
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** §10.3.2: model ids matching any of these are not text-in/text-out task models. */
export const EXCLUDED_MODEL_PATTERNS = [
  "embed",
  "aqa",
  "imagen",
  "veo",
  "lyria",
  "image",
  "tts",
  "audio",
  "live",
  "transcribe",
  "translate",
  "omni",
  "robotics",
  "computer-use",
  "gemma",
  "banana",
  "deep-research",
  "learnlm",
];

// ---------- ATS hosts (Appendix C.1) ----------
export const ATS_HOSTS = [
  "greenhouse.io",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "lever.co",
  "jobs.lever.co",
  "myworkdayjobs.com",
  "myworkday.com",
  "workday.com",
  "ashbyhq.com",
  "jobs.ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "taleo.net",
  "successfactors.com",
  "successfactors.eu",
  "bamboohr.com",
  "workable.com",
  "apply.workable.com",
  "recruitee.com",
  "breezy.hr",
  "applytojob.com",
  "jazzhr.com",
  "teamtailor.com",
  "personio.de",
  "personio.com",
  "rippling-ats.com",
  "ats.rippling.com",
  "dover.com",
  "wellfound.com",
  "oraclecloud.com",
  "ultipro.com",
  "paylocity.com",
  "adp.com",
  "pinpointhq.com",
  "hirebridge.com",
  "comeet.com",
  "freshteam.com",
  "zohorecruit.com",
  "clearcompany.com",
  "avature.net",
  "eightfold.ai",
  "phenompeople.com",
];

/** Hosts that only count as ATS when the path also matches. */
export const ATS_PATH_REQUIREMENTS: Record<string, RegExp> = {
  "oraclecloud.com": /\/hcmUI\//,
  "adp.com": /recruit/i,
};

export function isAtsHost(host: string, path: string): boolean {
  const h = host.toLowerCase();
  return ATS_HOSTS.some(
    (a) => (h === a || h.endsWith("." + a)) && (!ATS_PATH_REQUIREMENTS[a] || ATS_PATH_REQUIREMENTS[a].test(path)),
  );
}

export const RE_RESUME_FILE = /r[ée]sum[ée]|\bcv\b|cover letter/i;
export const RE_RESUME_ONLY = /r[ée]sum[ée]|\bcv\b/i;
export const RE_COVER_LETTER = /cover letter/i;

// ---------- Scanning (§11.3, §11.6, §18) ----------
export const RE_SKIP_LABEL = /captcha|honeypot|leave this (field )?(blank|empty)/i;
export const RE_COOKIE_CONTAINER = /cookie|consent-banner|onetrust|gdpr/i;
export const RE_NEWSLETTER = /newsletter|subscribe/i;
export const RE_SENSITIVE_LABEL =
  /card number|cvv|cvc|expiry|iban|routing|\bsin\b|social insurance|social security|ssn|passport (number|no)/i;
export const RE_CONSENT =
  /i (agree|acknowledge|certify|consent|confirm|understand|accept)|terms|privacy (policy|notice)|attest/i;
export const RE_HELPER_CLASS = /help|hint|description|desc|subtext|instructions/i;
/** Buttons/links the extension must never click (§18.1). */
export const RE_FORBIDDEN_CLICK = /submit|next|continue|apply|save|sign ?in|log ?in|sign ?up|register|finish|review/i;
/** Button texts that are never answer choices (used to reject button-style choice groups). */
export const RE_NAV_BUTTON =
  /submit|next|continue|apply|save|sign ?in|log ?in|sign ?up|register|finish|review|back|previous|cancel|close|delete|remove|upload|attach|search|\bedit\b|\badd\b/i;
export const RE_UPLOAD_BUTTON = /upload|attach|browse|choose file|select file/i;
export const RE_DROPZONE = /drag|drop|upload|attach/i;
export const RE_TYPEAHEAD_HINT =
  /location|city|school|university|college|company|employer|search|autocomplete|typeahead/i;
export const RE_PLACEHOLDER_OPTION = /^(select|choose|please select|--|—|-)(\b|\s|$)/i;
export const RE_NO_OPTIONS = /^(no options|no results|no matches|nothing found|loading)/i;

/** Appendix C.3 */
export const DROPDOWN_TRIGGER_SELECTORS = [
  "[role=combobox]",
  "[aria-haspopup=listbox]",
  '[class*="select__control"]',
  '[class*="Select-control"]',
  '[class*="MuiSelect"]',
  '[class*="MuiAutocomplete"]',
  ".ant-select-selector",
  ".choices__inner",
  ".select2-selection",
  ".vs__dropdown-toggle",
  '[class*="dropdown-toggle"]',
  '[data-automation-id*="select" i]',
  '[data-testid*="select" i]',
].join(",");

export const OPTION_SELECTORS = [
  "[role=option]",
  '[class*="select__option"]',
  '[class*="Select-option"]',
  ".MuiAutocomplete-option",
  ".MuiMenuItem-root",
  ".ant-select-item-option",
  ".choices__item--choice",
  ".select2-results__option",
  ".vs__dropdown-option",
  "li[data-value]",
  '[data-automation-id*="promptOption" i]',
].join(",");

// ---------- Deterministic mapping (§13.2, Appendix C.2) ----------
export type DetKey =
  | "fullName"
  | "firstName"
  | "middleName"
  | "lastName"
  | "preferredName"
  | "pronouns"
  | "email"
  | "phone"
  | "phoneNational"
  | "phoneCountryCode"
  | "streetAddress"
  | "line1"
  | "line2"
  | "city"
  | "region"
  | "postalCode"
  | "country"
  | "countryCode"
  | "url"
  | "linkedin"
  | "github"
  | "portfolio"
  | "dateOfBirth";

export const AUTOCOMPLETE_MAP: Record<string, DetKey> = {
  name: "fullName",
  "given-name": "firstName",
  "additional-name": "middleName",
  "family-name": "lastName",
  nickname: "preferredName",
  email: "email",
  tel: "phone",
  "tel-national": "phoneNational",
  "tel-country-code": "phoneCountryCode",
  "street-address": "streetAddress",
  "address-line1": "line1",
  "address-line2": "line2",
  "address-level2": "city",
  "address-level1": "region",
  "postal-code": "postalCode",
  "country-name": "country",
  country: "countryCode",
  url: "url",
  bday: "dateOfBirth",
};

/** Word boundaries were added to state/region/unit/apt so "personal statement" etc. don't match. */
export const LABEL_RULES: [RegExp, DetKey][] = [
  [/^first\s*name|given name|legal first/i, "firstName"],
  [/^last\s*name|surname|family name/i, "lastName"],
  [/^(full\s*)?name$/i, "fullName"],
  [/preferred (first )?name/i, "preferredName"],
  [/e-?mail/i, "email"],
  [/phone|mobile|cell/i, "phone"],
  [/country code|dialing code/i, "phoneCountryCode"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  [/portfolio|personal (web)?site|website/i, "portfolio"],
  [/^city|\btown\b/i, "city"],
  [/postal|zip/i, "postalCode"],
  [/pronouns?/i, "pronouns"],
  [/^address( line)? ?1|street address/i, "line1"],
  [/address( line)? ?2|\bapt\b|\bsuite\b|\bunit\b/i, "line2"],
  [/\b(province|state|region)\b/i, "region"],
  [/^country$/i, "country"],
];

// ---------- Country / region aliases (§13.1) ----------
/** ISO-3166 alpha-2 + alpha-3 pairs, packed as "ADAND AEARE …". */
const ISO_PAIRS =
  "ADANDAEAREAFAFGAGATGAIAIAALALBAMARMAOAGOAQATAARARGASASMATAUTAUAUSAWABWAXALAAZAZEBABIHBBBRBBDBGDBEBELBFBFABGBGRBHBHRBIBDIBJBENBLBLMBMBMUBNBRNBOBOLBQBESBRBRABSBHSBTBTNBVBVTBWBWABYBLRBZBLZCACANCCCCKCDCODCFCAFCGCOGCHCHECICIVCKCOKCLCHLCMCMRCNCHNCOCOLCRCRICUCUBCVCPVCWCUWCXCXRCYCYPCZCZEDEDEUDJDJIDKDNKDMDMADODOMDZDZAECECUEEESTEGEGYEHESHERERIESESPETETHFIFINFJFJIFKFLKFMFSMFOFROFRFRAGAGABGBGBRGDGRDGEGEOGFGUFGGGGYGHGHAGIGIBGLGRLGMGMBGNGINGPGLPGQGNQGRGRCGSSGSGTGTMGUGUMGWGNBGYGUYHKHKGHMHMDHNHNDHRHRVHTHTIHUHUNIDIDNIEIRLILISRIMIMNININDIOIOTIQIRQIRIRNISISLITITAJEJEYJMJAMJOJORJPJPNKEKENKGKGZKHKHMKIKIRKMCOMKNKNAKPPRKKRKORKWKWTKYCYMKZKAZLALAOLBLBNLCLCALILIELKLKALRLBRLSLSOLTLTULULUXLVLVALYLBYMAMARMCMCOMDMDAMEMNEMFMAFMGMDGMHMHLMKMKDMLMLIMMMMRMNMNGMOMACMPMNPMQMTQMRMRTMSMSRMTMLTMUMUSMVMDVMWMWIMXMEXMYMYSMZMOZNANAMNCNCLNENERNFNFKNGNGANINICNLNLDNONORNPNPLNRNRUNUNIUNZNZLOMOMNPAPANPEPERPFPYFPGPNGPHPHLPKPAKPLPOLPMSPMPNPCNPRPRIPSPSEPTPRTPWPLWPYPRYQAQATREREUROROURSSRBRURUSRWRWASASAUSBSLBSCSYCSDSDNSESWESGSGPSHSHNSISVNSJSJMSKSVKSLSLESMSMRSNSENSOSOMSRSURSSSSDSTSTPSVSLVSXSXMSYSYRSZSWZTCTCATDTCDTFATFTGTGOTHTHATJTJKTKTKLTLTLSTMTKMTNTUNTOTONTRTURTTTTOTVTUVTWTWNTZTZAUAUKRUGUGAUMUMIUSUSAUYURYUZUZBVAVATVCVCTVEVENVGVGBVIVIRVNVNMVUVUTWFWLFWSWSMXKXKKYEYEMYTMYTZAZAFZMZMBZWZWE";

const COUNTRY_EXTRAS: Record<string, string> = {
  usa: "US",
  "united states of america": "US",
  america: "US",
  "u s": "US",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "south korea": "KR",
  "republic of korea": "KR",
  korea: "KR",
  "north korea": "KP",
  russia: "RU",
  "russian federation": "RU",
  "czech republic": "CZ",
  turkey: "TR",
  turkiye: "TR",
  "ivory coast": "CI",
  burma: "MM",
  myanmar: "MM",
  "hong kong": "HK",
  macau: "MO",
  macao: "MO",
  vietnam: "VN",
  "viet nam": "VN",
  laos: "LA",
  iran: "IR",
  syria: "SY",
  taiwan: "TW",
  holland: "NL",
  "the netherlands": "NL",
  uae: "AE",
  emirates: "AE",
  palestine: "PS",
  vatican: "VA",
  "vatican city": "VA",
  bolivia: "BO",
  venezuela: "VE",
  tanzania: "TZ",
  moldova: "MD",
  micronesia: "FM",
  swaziland: "SZ",
  eswatini: "SZ",
  "cape verde": "CV",
  "east timor": "TL",
  "timor leste": "TL",
  macedonia: "MK",
  "north macedonia": "MK",
  "republic of the congo": "CG",
  drc: "CD",
  "democratic republic of the congo": "CD",
  "congo kinshasa": "CD",
  "congo brazzaville": "CG",
  "saint lucia": "LC",
  "st lucia": "LC",
  "saint kitts and nevis": "KN",
  "st kitts and nevis": "KN",
  "saint vincent and the grenadines": "VC",
  "st vincent and the grenadines": "VC",
  "people s republic of china": "CN",
  "peoples republic of china": "CN",
  prc: "CN",
};

const REGIONS: [string, string][] = [
  ["AB", "Alberta"],
  ["BC", "British Columbia"],
  ["MB", "Manitoba"],
  ["NB", "New Brunswick"],
  ["NL", "Newfoundland and Labrador"],
  ["NS", "Nova Scotia"],
  ["NT", "Northwest Territories"],
  ["NU", "Nunavut"],
  ["ON", "Ontario"],
  ["PE", "Prince Edward Island"],
  ["QC", "Quebec"],
  ["SK", "Saskatchewan"],
  ["YT", "Yukon"],
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["DC", "District of Columbia"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
  ["PR", "Puerto Rico"],
];

let countryAliases: Map<string, string> | null = null;
let regionAliases: Map<string, string> | null = null;

/** normalized alias → normalized canonical English country name. Built lazily from Intl.DisplayNames. */
export function COUNTRY_ALIASES(): Map<string, string> {
  if (countryAliases) return countryAliases;
  const m = new Map<string, string>();
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const canonOf = (a2: string) => normalize(names.of(a2) ?? a2);
  for (let i = 0; i < ISO_PAIRS.length; i += 5) {
    const a2 = ISO_PAIRS.slice(i, i + 2);
    const canon = canonOf(a2);
    m.set(a2.toLowerCase(), canon);
    m.set(ISO_PAIRS.slice(i + 2, i + 5).toLowerCase(), canon);
    m.set(canon, canon);
  }
  for (const [alias, a2] of Object.entries(COUNTRY_EXTRAS)) m.set(normalize(alias), canonOf(a2));
  countryAliases = m;
  return m;
}

/** normalized alias (code or name) → normalized canonical region name (Canada + US). */
export function REGION_ALIASES(): Map<string, string> {
  if (regionAliases) return regionAliases;
  const m = new Map<string, string>();
  for (const [code, name] of REGIONS) {
    m.set(code.toLowerCase(), normalize(name));
    m.set(normalize(name), normalize(name));
  }
  m.set("quebec", "quebec");
  m.set("pei", "prince edward island");
  m.set("newfoundland", "newfoundland and labrador");
  m.set("washington dc", "district of columbia");
  regionAliases = m;
  return m;
}

export const canonicalCountry = (s: string): string | null => COUNTRY_ALIASES().get(normalize(s)) ?? null;
export const canonicalRegion = (s: string): string | null => REGION_ALIASES().get(normalize(s)) ?? null;
export const regionCode = (s: string): string | null => {
  const c = canonicalRegion(s);
  return c ? (REGIONS.find(([, n]) => normalize(n) === c)?.[0] ?? null) : null;
};
