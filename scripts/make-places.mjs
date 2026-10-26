// Generates public/places.txt, read by src/background/yolo/places.ts, from GeoNames (CC BY 4.0). Run once; output is
// committed. Download into one folder
// https://download.geonames.org/export/dump/{cities15000.zip,cities5000.zip,admin1CodesASCII.txt}, unzip, then:
//   node scripts/make-places.mjs <folder>
// Cities: every one of 15,000+ people, and Canada's and the US's of 5,000+ (their postings often omit the country).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalize } from "../src/shared/normalize.ts";

// City names that are words a location line uses for something else ("Downtown Toronto", "Remote - Asia").
const SKIP = new Set(["asia", "central", "downtown", "metro", "uptown"]);

const dir = process.argv[2];
const rows = (f) =>
  readFileSync(join(dir, f), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));

const regions = [];
const regionIndex = new Map();
for (const [code, name] of rows("admin1CodesASCII.txt")) {
  regionIndex.set(code, regions.length);
  regions.push(`${normalize(name)}|${code.slice(0, 2).toLowerCase()}`);
}
// A city outside any first-level region gets its country's own "|cc" line.
const regionOf = (cc, admin1) => {
  const key = regionIndex.has(`${cc}.${admin1}`) ? `${cc}.${admin1}` : cc;
  if (!regionIndex.has(key)) regionIndex.set(key, regions.push(`|${cc.toLowerCase()}`) - 1);
  return regionIndex.get(key);
};

const seen = new Set();
const cities = [...rows("cities15000.txt"), ...rows("cities5000.txt").filter((r) => r[8] === "CA" || r[8] === "US")]
  .filter((r) => !seen.has(r[0]) && seen.add(r[0]) && !SKIP.has(normalize(r[2])))
  .sort((a, b) => b[14] - a[14]) // most populous first: a bare "London" means England's
  .map((r) => [normalize(r[2]), regionOf(r[8], r[10]).toString(36)])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // by name for binary search; stable, so namesakes stay by size
  .map(([name, region]) => `${name}|${region}`);

// Regions ("region|cc", "|cc" for a country with none), a blank line, then "\ncity|region line in base 36" per city.
writeFileSync("public/places.txt", `${regions.join("\n")}\n${cities.map((c) => `\n${c}`).join("")}`);
console.log(`${regions.length} regions, ${cities.length} cities`);
