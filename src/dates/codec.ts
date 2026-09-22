/**
 * All MOCA date formatting and parsing goes through this module (spec §8a).
 * Future versions add time-zone and Date-column options by supplying a different codec.
 */
export interface DateCodec {
  format(date: Date): string;
  parse(value: string): Date;
}

const MIN_MOCA_YEAR = 0;
const MAX_MOCA_YEAR = 9999;

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** Formats a Date as `YYYYMMDDHH24MISS` (14 digits, 24-hour clock, local time zone). */
export function formatMocaDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('Cannot format an invalid Date as a MOCA date');
  const year = date.getFullYear();
  if (year < MIN_MOCA_YEAR || year > MAX_MOCA_YEAR) {
    throw new RangeError(`Cannot format a MOCA date with year ${year} outside ${MIN_MOCA_YEAR}-${MAX_MOCA_YEAR}`);
  }
  return (
    pad(year, 4) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/** Parses a 14-digit `YYYYMMDDHH24MISS` MOCA date as local time. */
export function parseMocaDate(value: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (match === null) throw new RangeError(`Not a MOCA date (expected YYYYMMDDHH24MISS): ${value}`);
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // Use setFullYear rather than the Date constructor's year argument: the constructor
  // (and multi-arg forms) special-case a two-digit year (0-99) as 1900+year, which would
  // corrupt years below 100.
  const daysInMonthProbe = new Date(2000, 0, 1);
  daysInMonthProbe.setFullYear(year, month, 0);
  const daysInMonth = daysInMonthProbe.getDate();

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hours > 23 || minutes > 59 || seconds > 59) {
    throw new RangeError(`Out-of-range MOCA date: ${value}`);
  }

  const date = new Date(2000, 0, 1, hours, minutes, seconds);
  date.setFullYear(year, month - 1, day);

  // A spring-forward DST transition can make an hour:minute combination not exist in the
  // local time zone; setFullYear silently normalizes it to a different wall-clock time.
  // Detect that by checking the time-of-day survived the date being set.
  if (date.getHours() !== hours || date.getMinutes() !== minutes) {
    throw new RangeError(`MOCA date ${value} does not exist in the local time zone (DST gap)`);
  }

  return date;
}

export const defaultDateCodec: DateCodec = { format: formatMocaDate, parse: parseMocaDate };
