/**
 * Minimal 5-field cron parser: "min hour day-of-month month day-of-week".
 * Supports: * , - / and the aliases @hourly @daily @weekly @monthly @yearly.
 * Day-of-week: 0-7 (0 and 7 are Sunday). Times are interpreted in the server's local timezone.
 */
type Field = Set<number>;
export type Cron = { min: Field; hour: Field; dom: Field; mon: Field; dow: Field; domStar: boolean; dowStar: boolean };

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function parseField(spec: string, lo: number, hi: number, names?: Record<string, number>): Field {
  const set = new Set<number>();
  for (let part of spec.split(",")) {
    part = part.trim().toLowerCase();
    if (!part) throw new Error(`empty cron field part in "${spec}"`);
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      step = Number(part.slice(slash + 1));
      part = part.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${spec}"`);
    }
    let a: number, b: number;
    if (part === "*") { a = lo; b = hi; }
    else {
      const [x, y] = part.split("-");
      const conv = (v: string) => {
        if (names && v in names) return names[v];
        const n = Number(v);
        if (!Number.isInteger(n)) throw new Error(`bad value "${v}" in cron field "${spec}"`);
        return n;
      };
      a = conv(x);
      b = y === undefined ? (slash >= 0 ? hi : a) : conv(y);
    }
    if (a < lo || b > hi || a > b) throw new Error(`cron value out of range ${lo}-${hi}: "${spec}"`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseCron(expr: string): Cron {
  let e = expr.trim();
  if (e in ALIASES) e = ALIASES[e];
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error(`cron expression must have 5 fields, got ${f.length}: "${expr}"`);
  const dow = parseField(f[4], 0, 7, DAYS);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    min: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    mon: parseField(f[3], 1, 12, MONTHS),
    dow,
    domStar: f[2].trim() === "*",
    dowStar: f[4].trim() === "*",
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  if (!c.mon.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  // Standard cron semantics: if both dom and dow are restricted, either may match.
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  if (!c.domStar) return domOk;
  if (!c.dowStar) return dowOk;
  return true;
}

/** Next matching time strictly after `after` (ms), or null if none within ~2 years. */
export function nextCron(expr: string | Cron, after: number = Date.now()): number | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const hours = [...c.hour].sort((a, b) => a - b);
  const mins = [...c.min].sort((a, b) => a - b);
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 366 * 2; i++) {
    if (dayMatches(c, day)) {
      for (const h of hours) {
        for (const m of mins) {
          const t = new Date(day);
          t.setHours(h, m, 0, 0);
          if (t.getTime() >= start.getTime() && t.getHours() === h) return t.getTime();
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

export function validateCron(expr: string): string | null {
  try { parseCron(expr); return null; } catch (e: any) { return e.message; }
}
