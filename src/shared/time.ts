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
  const wall = new Date(laWall(now));
  const target = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  let t = target - (laWall(now) - now);
  t = target - (laWall(t) - t);
  return t;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatPacific(ts: number): string {
  return (
    new Date(ts).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }) + " PT"
  );
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export const todayIso = (now = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
