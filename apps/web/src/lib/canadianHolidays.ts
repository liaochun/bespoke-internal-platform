// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
// Ontario/Canada statutory holidays, computed for any given year.
// No external dependencies — all date math is done here.
// To reconnect additional provinces or federal-only days, extend getOntarioHolidays().

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Easter Sunday — Anonymous Gregorian algorithm.
function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-based
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

// Nth Monday (n=1,2,3…) of a 0-based month.
function nthMonday(year: number, month: number, n: number): Date {
  const firstDow = new Date(year, month, 1).getDay(); // 0=Sun
  const offset = (8 - firstDow) % 7; // days until first Monday (0 if 1st is Mon)
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

// Monday strictly before a given day-of-month (so May 25 Mon → May 18).
function mondayBefore(year: number, month: number, dayOfMonth: number): Date {
  const dow = new Date(year, month, dayOfMonth).getDay(); // 0=Sun, 1=Mon…
  const daysBack = dow === 1 ? 7 : ((dow + 6) % 7 || 7);
  return new Date(year, month, dayOfMonth - daysBack);
}

export interface StatHoliday {
  date: string; // YYYY-MM-DD
  name: string;
}

export function getOntarioHolidays(year: number): StatHoliday[] {
  const easter = easterSunday(year);
  const goodFriday = new Date(easter.getTime() - 2 * 86_400_000);
  return [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: ymd(nthMonday(year, 1, 3)), name: "Family Day" },      // 3rd Mon of Feb
    { date: ymd(goodFriday),            name: "Good Friday" },
    { date: ymd(mondayBefore(year, 4, 25)), name: "Victoria Day" }, // Mon before May 25
    { date: `${year}-07-01`,            name: "Canada Day" },
    { date: ymd(nthMonday(year, 8, 1)), name: "Labour Day" },      // 1st Mon of Sep
    { date: ymd(nthMonday(year, 9, 2)), name: "Thanksgiving" },    // 2nd Mon of Oct
    { date: `${year}-12-25`,            name: "Christmas Day" },
    { date: `${year}-12-26`,            name: "Boxing Day" },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

// Returns the holiday name for a YYYY-MM-DD string, or null if not a holiday.
export function getHolidayName(dateStr: string): string | null {
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (!year) return null;
  return getOntarioHolidays(year).find((h) => h.date === dateStr)?.name ?? null;
}
