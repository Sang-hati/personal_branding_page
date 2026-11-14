// Pure helpers for the contribution calendar: intensity levels and streaks.
// All dates are plain YYYY-MM-DD strings in UTC, which compare correctly as text.

const DAY_MS = 86_400_000;

export const toISODate = (date) => date.toISOString().slice(0, 10);
export const addDays = (iso, n) => toISODate(new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS));

/**
 * Sets `level` (0 to 4) on every day. Levels come from the quartiles of the
 * non-zero days, so one huge day does not wash out the rest of the year.
 * Days with count === null (no data) get level 0.
 */
export function addLevels(days) {
  const nonZero = days.filter((d) => d.count > 0).map((d) => d.count).sort((a, b) => a - b);
  const n = nonZero.length;
  const at = (p) => (n ? nonZero[Math.max(0, Math.ceil(p * n) - 1)] : 0);
  const t1 = at(0.25);
  const t2 = at(0.5);
  const t3 = at(0.75);
  for (const d of days) {
    if (!d.count) d.level = 0;
    else if (d.count <= t1) d.level = 1;
    else if (d.count <= t2) d.level = 2;
    else if (d.count <= t3) d.level = 3;
    else d.level = 4;
  }
  return days;
}

/**
 * days: [{ date, count }] in ascending order, count === null means "no data".
 * A streak is a run of consecutive days with at least one contribution.
 * The current streak is not broken by an empty "today", because the day is not over yet.
 */
export function computeStreaks(days) {
  const tracked = days.filter((d) => d.count !== null);
  const total = tracked.reduce((sum, d) => sum + d.count, 0);
  const activeDays = tracked.filter((d) => d.count > 0).length;

  let longest = { length: 0, start: null, end: null };
  let run = null;
  for (const d of tracked) {
    if (d.count > 0) {
      run = run ? { start: run.start, end: d.date, length: run.length + 1 } : { start: d.date, end: d.date, length: 1 };
      if (run.length >= longest.length) longest = run; // ties go to the most recent run
    } else {
      run = null;
    }
  }

  let i = tracked.length - 1;
  let endsToday = true;
  if (i >= 0 && tracked[i].count === 0) {
    i -= 1;
    endsToday = false;
  }
  const endIndex = i;
  let length = 0;
  while (i >= 0 && tracked[i].count > 0) {
    length += 1;
    i -= 1;
  }
  const current = length
    ? { length, start: tracked[i + 1].date, end: tracked[endIndex].date, endsToday }
    : { length: 0, start: null, end: null, endsToday: false };

  let busiest = null;
  for (const d of tracked) if (d.count > 0 && (!busiest || d.count >= busiest.count)) busiest = { date: d.date, count: d.count };

  return {
    current,
    longest,
    total,
    activeDays,
    trackedDays: tracked.length,
    busiest,
    perActiveDay: activeDays ? Math.round((total / activeDays) * 10) / 10 : 0,
  };
}
