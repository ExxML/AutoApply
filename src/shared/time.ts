const laParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/** Los Angeles wall-clock time of `ts`, expressed as if it were UTC. */
function laWall(ts: number): number {
  const p: Record<string, number> = {};
  for (const { type, value } of laParts.formatToParts(ts)) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Next 00:00 in America/Los_Angeles (DST-safe: offsets come from Intl, not constants). */
export function nextMidnightPacific(now = Date.now()): number {
  // laWall has second precision, so offsets are measured against whole seconds.
  const offset = (ts: number) => laWall(ts) - Math.floor(ts / 1000) * 1000;
  const wall = new Date(laWall(now));
  const target = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  const guess = target - offset(now);
  return target - offset(guess);
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export const todayIso = (now = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
