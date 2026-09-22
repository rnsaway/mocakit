/**
 * All MOCA date formatting and parsing goes through this module (spec §8a).
 * Future versions add time-zone and Date-column options by supplying a different codec.
 */
export interface DateCodec {
  format(date: Date): string;
  parse(value: string): Date;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** Formats a Date as `YYYYMMDDHH24MISS` (14 digits, 24-hour clock, local time zone). */
export function formatMocaDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('Cannot format an invalid Date as a MOCA date');
  return (
    pad(date.getFullYear(), 4) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/** Parses a 14-digit `YYYYMMDDHH24MISS` MOCA date as local time. */
export function parseMocaDate(value: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (match === null) throw new RangeError(`Not a MOCA date (expected YYYYMMDDHH24MISS): ${value}`);
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const daysInMonth = new Date(year, month, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hours > 23 || minutes > 59 || seconds > 59) {
    throw new RangeError(`Out-of-range MOCA date: ${value}`);
  }
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

export const defaultDateCodec: DateCodec = { format: formatMocaDate, parse: parseMocaDate };
