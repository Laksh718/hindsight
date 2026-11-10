/**
 * Time is a first-class input in Hindsight, not an ambient global.
 *
 * Every turn carries an explicit `now` and the user's time zone. That makes
 * "last Tuesday" resolvable, keeps memory honest about when something was
 * said, and lets tests (and the time-travel switch in the UI) run the agent
 * at any date.
 *
 * Day keys ("2026-11-03") are calendar days in the user's time zone. All
 * day arithmetic happens on those keys, so daylight-saving shifts and
 * server time zones never leak into answers.
 */
import * as chrono from 'chrono-node';

export type DayKey = string; // YYYY-MM-DD in the user's time zone

/** A span of calendar days the user referred to, inclusive on both ends. */
export interface DayWindow {
  phrase: string; // the words in the message, e.g. "last Tuesday"
  from: DayKey;
  to: DayKey;
  /** True for the second reading of an ambiguous phrase ("last Monday" said on a Tuesday). */
  alternative?: boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zonedParts(at: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(at)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as unknown as ZonedParts;
}

/** Minutes the user's zone is ahead of UTC at a given instant (IST = 330). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(at: Date | string, tz: string): DayKey {
  const p = zonedParts(typeof at === 'string' ? new Date(at) : at, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function keyToUtc(key: DayKey): Date {
  return new Date(`${key}T00:00:00Z`);
}

export function addDays(key: DayKey, days: number): DayKey {
  const d = keyToUtc(key);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekday(key: DayKey): number {
  return keyToUtc(key).getUTCDay();
}

export function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((keyToUtc(b).getTime() - keyToUtc(a).getTime()) / 86_400_000);
}

/** Monday of the week containing `key` (weeks start on Monday). */
function startOfWeek(key: DayKey): DayKey {
  return addDays(key, -((weekday(key) + 6) % 7));
}

/** "Tue 3 Nov 2026" */
export function formatDay(key: DayKey, opts: { year?: boolean } = {}): string {
  const d = keyToUtc(key);
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return opts.year === false ? base : `${base} ${d.getUTCFullYear()}`;
}

/** "Tuesday 10 November 2026, 21:30" in the user's zone. */
export function formatNow(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return `${WEEKDAYS_LONG[weekday(key)]} ${p.day} ${MONTHS_LONG[p.month - 1]} ${p.year}, ${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatTime(at: Date | string, tz: string): string {
  const p = zonedParts(typeof at === 'string' ? new Date(at) : at, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "today", "yesterday", "5 days ago", "3 weeks ago" */
export function relativeDay(key: DayKey, today: DayKey): string {
  const n = daysBetween(key, today);
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n === -1) return 'tomorrow';
  if (n < 0) return `in ${-n} days`;
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  return `${Math.round(n / 30)} months ago`;
}

/**
 * A two-week calendar for the system prompt. Models are unreliable at date
 * arithmetic but reliable at lookup, so we hand them a table instead of
 * asking them to count backwards from today.
 */
export function calendarTable(now: Date, tz: string, days = 14): string {
  const today = dayKey(now, tz);
  const thisWeek = startOfWeek(today);
  const rows: string[] = [];
  for (let i = 0; i < days; i++) {
    const key = addDays(today, -i);
    const notes = [relativeDay(key, today)];
    if (i > 0 && key >= thisWeek) notes.push(`this ${WEEKDAYS_LONG[weekday(key)]}`);
    if (i > 0 && key < thisWeek && key >= addDays(thisWeek, -7)) notes.push(`last week's ${WEEKDAYS_LONG[weekday(key)]}`);
    rows.push(`${formatDay(key)}  (${notes.join(', ')})`);
  }
  return rows.join('\n');
}

// Phrases chrono reads as a single day but people mean as a span.
const SPAN_RULES: Array<{ re: RegExp; span: (today: DayKey, m: RegExpMatchArray) => [DayKey, DayKey] }> = [
  { re: /\blast week\b/i, span: (t) => [addDays(startOfWeek(t), -7), addDays(startOfWeek(t), -1)] },
  { re: /\bthis week\b/i, span: (t) => [startOfWeek(t), t] },
  { re: /\b(?:the )?other day\b|\brecently\b|\ba few days ago\b|\bfew days back\b/i, span: (t) => [addDays(t, -7), addDays(t, -1)] },
  { re: /\b(?:past|last) (\d+) days\b/i, span: (t, m) => [addDays(t, -Math.min(Number(m[1]), 365)), t] },
  { re: /\blast month\b/i, span: (t) => {
    const d = keyToUtc(t);
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
    return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
  } },
];

/**
 * Turn the time expressions in a message into concrete day windows.
 *
 * Deterministic on purpose: this decides which past conversations get
 * recalled, and a wrong guess here means the model never sees the right
 * memory. The bias is towards the past, because people asking about what
 * they said are always talking about the past.
 */
export function resolveDates(text: string, now: Date, tz: string): DayWindow[] {
  const today = dayKey(now, tz);
  const windows: DayWindow[] = [];
  let rest = text;

  for (const rule of SPAN_RULES) {
    const m = rest.match(rule.re);
    if (!m) continue;
    const [from, to] = rule.span(today, m);
    windows.push({ phrase: m[0], from, to });
    rest = rest.replace(m[0], ' '.repeat(m[0].length)); // keep offsets, stop chrono re-reading it
  }

  const ref = { instant: now, timezone: tzOffsetMinutes(now, tz) };
  for (const r of chrono.parse(rest, ref, { forwardDate: false })) {
    const phrase = r.text.trim();
    // "Is that still true today?" points at the present, not at a memory.
    if (/^(?:today|now|right now|currently|tonight)$/i.test(phrase)) continue;

    const year = r.start.get('year');
    const month = r.start.get('month');
    const day = r.start.get('day');
    if (!year || !month || !day) continue;
    let key: DayKey = `${year}-${pad(month)}-${pad(day)}`;

    const isWeekday = r.start.isCertain('weekday') && !r.start.isCertain('day');
    if (isWeekday) {
      // A bare weekday always means the most recent one before today.
      while (key >= today) key = addDays(key, -7);
      while (daysBetween(key, today) > 7) key = addDays(key, 7);
      windows.push({ phrase, from: key, to: key });
      // "last Monday" said on a Tuesday: yesterday, or the Monday before?
      if (/\blast\b/i.test(phrase) && key >= startOfWeek(today)) {
        const alt = addDays(key, -7);
        windows.push({ phrase, from: alt, to: alt, alternative: true });
      }
      continue;
    }

    // "3 November" said in October means last November.
    if (key > today && !r.start.isCertain('year')) key = `${year - 1}${key.slice(4)}`;
    if (key > today) continue; // a genuine future date is not a memory

    let to = key;
    if (r.end) {
      const e = r.end;
      const endKey = `${e.get('year')}-${pad(e.get('month') ?? 1)}-${pad(e.get('day') ?? 1)}`;
      if (endKey >= key) to = endKey > today ? today : endKey;
    } else if (!r.start.isCertain('day') && r.start.isCertain('month')) {
      // "in October": the whole month.
      const last = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0));
      key = `${key.slice(0, 8)}01`;
      to = last.toISOString().slice(0, 10);
      if (to > today) to = today;
    }
    windows.push({ phrase, from: key, to });
  }

  // Same window mentioned twice ("on Monday ... since Monday") counts once.
  const seen = new Set<string>();
  return windows.filter((w) => {
    const id = `${w.from}..${w.to}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function describeWindow(w: DayWindow): string {
  return w.from === w.to ? formatDay(w.from) : `${formatDay(w.from)} to ${formatDay(w.to)}`;
}
