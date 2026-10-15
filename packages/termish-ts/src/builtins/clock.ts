/**
 * `date`, and the strftime it formats with (shared with `stat`).
 *
 * Only the current time: no `-d` (parsing a date) and no setting the
 * clock. Times show in the host's local zone, or UTC with `-u`.
 *
 * Mirrors termish-py's `clock.py`, conversion for conversion.
 */

import type { CommandHandler } from '../context'
import { TerminalError } from '../errors'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `date` with no format: `Thu Oct 15 14:23:01 PDT 2026`. */
export const DEFAULT_DATE_FORMAT = '%a %b %e %H:%M:%S %Z %Y'

/** `-I`'s precisions, as formats. */
const ISO_FORMATS: Readonly<Record<string, string>> = {
  date: '%Y-%m-%d',
  hours: '%Y-%m-%dT%H%:z',
  minutes: '%Y-%m-%dT%H:%M%:z',
  seconds: '%Y-%m-%dT%H:%M:%S%:z',
}

const pad = (n: number, width = 2, fill = '0'): string => String(n).padStart(width, fill)

/** A moment's calendar fields, in the local zone or UTC. */
interface Fields {
  year: number
  month: number // 0-11
  day: number
  weekday: number // 0 = Sunday
  hour: number
  minute: number
  second: number
  /** Minutes east of UTC. */
  offset: number
  zone: string
}

function fieldsOf(date: Date, utc: boolean): Fields {
  if (utc) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      weekday: date.getUTCDay(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      offset: 0,
      zone: 'UTC',
    }
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    weekday: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    offset: -date.getTimezoneOffset(),
    zone: localZoneName(date),
  }
}

/** The local zone's short name at `date` (`PDT`, `UTC`), or its offset
 *  where the platform has no name for it. */
function localZoneName(date: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')
    if (part !== undefined && /^[A-Z]{2,5}$/.test(part.value)) return part.value
  } catch {
    // no Intl: fall through to the offset
  }
  return offsetText(-date.getTimezoneOffset(), false)
}

/** `+hhmm`, or `+hh:mm` with `colon`. */
function offsetText(offset: number, colon: boolean): string {
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${sign}${pad(Math.floor(abs / 60))}${colon ? ':' : ''}${pad(abs % 60)}`
}

function dayOfYear(f: Fields): number {
  const start = Date.UTC(f.year, 0, 1)
  return Math.round((Date.UTC(f.year, f.month, f.day) - start) / 86_400_000) + 1
}

/**
 * Format `date` by `format`'s strftime conversions: `%Y %y %m %d %e
 * %j %H %I %M %S %p %s %a %A %b %B %u %w %z %:z %Z %F %T %D %R %n %t
 * %%`. Any other `%` sequence is kept as written.
 */
export function strftime(date: Date, format: string, utc: boolean): string {
  const f = fieldsOf(date, utc)
  let out = ''
  for (let i = 0; i < format.length; i++) {
    const ch = format[i] as string
    if (ch !== '%' || i === format.length - 1) {
      out += ch
      continue
    }
    let code = format[++i] as string
    if (code === ':' && format[i + 1] === 'z') {
      code = ':z'
      i++
    }
    switch (code) {
      case 'Y':
        out += String(f.year)
        break
      case 'y':
        out += pad(f.year % 100)
        break
      case 'm':
        out += pad(f.month + 1)
        break
      case 'd':
        out += pad(f.day)
        break
      case 'e':
        out += pad(f.day, 2, ' ')
        break
      case 'j':
        out += pad(dayOfYear(f), 3)
        break
      case 'H':
        out += pad(f.hour)
        break
      case 'I':
        out += pad(f.hour % 12 === 0 ? 12 : f.hour % 12)
        break
      case 'M':
        out += pad(f.minute)
        break
      case 'S':
        out += pad(f.second)
        break
      case 'p':
        out += f.hour < 12 ? 'AM' : 'PM'
        break
      case 's':
        out += String(Math.floor(date.getTime() / 1000))
        break
      case 'a':
        out += (DAYS[f.weekday] as string).slice(0, 3)
        break
      case 'A':
        out += DAYS[f.weekday] as string
        break
      case 'b':
        out += (MONTHS[f.month] as string).slice(0, 3)
        break
      case 'B':
        out += MONTHS[f.month] as string
        break
      case 'u':
        out += String(f.weekday === 0 ? 7 : f.weekday)
        break
      case 'w':
        out += String(f.weekday)
        break
      case 'z':
        out += offsetText(f.offset, false)
        break
      case ':z':
        out += offsetText(f.offset, true)
        break
      case 'Z':
        out += f.zone
        break
      case 'F':
        out += `${f.year}-${pad(f.month + 1)}-${pad(f.day)}`
        break
      case 'T':
        out += `${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`
        break
      case 'D':
        out += `${pad(f.month + 1)}/${pad(f.day)}/${pad(f.year % 100)}`
        break
      case 'R':
        out += `${pad(f.hour)}:${pad(f.minute)}`
        break
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case '%':
        out += '%'
        break
      default:
        out += `%${code}`
    }
  }
  return out
}

/**
 * `date [-u] [-I[PREC] | --iso-8601[=PREC] | -R | +FORMAT]`
 *
 * The current time: by default as `Thu Oct 15 14:23:01 PDT 2026`;
 * `+FORMAT` with strftime conversions; `-I` (`date`, `hours`,
 * `minutes` or `seconds`) as ISO 8601; `-R` as RFC 5322. `-u` shows
 * UTC.
 */
export const date: CommandHandler = async (ctx) => {
  let utc = false
  let format: string | null = null
  const setFormat = (f: string): void => {
    if (format !== null) throw new TerminalError('date: multiple output formats specified')
    format = f
  }
  for (const arg of ctx.args) {
    if (arg === '-u' || arg === '--utc' || arg === '--universal') utc = true
    else if (arg === '-R' || arg === '--rfc-email') setFormat('%a, %d %b %Y %H:%M:%S %z')
    else if (arg.startsWith('-I') || arg === '--iso-8601' || arg.startsWith('--iso-8601=')) {
      const prec = arg.startsWith('-I') ? arg.slice(2) : arg.slice('--iso-8601='.length)
      const iso = ISO_FORMATS[prec === '' ? 'date' : prec]
      if (iso === undefined) {
        throw new TerminalError(
          `date: invalid argument '${prec}' for --iso-8601 (use date, hours, minutes or seconds)`,
        )
      }
      setFormat(iso)
    } else if (arg.startsWith('+')) setFormat(arg.slice(1))
    else if (arg === '-d' || arg.startsWith('--date')) {
      throw new TerminalError('date: -d/--date is not supported; only the current time is shown')
    } else if (arg.startsWith('-')) throw new TerminalError(`date: unknown option: ${arg}`)
    else throw new TerminalError(`date: setting the date is not supported: '${arg}'`)
  }
  ctx.stdout.write(`${strftime(new Date(), format ?? DEFAULT_DATE_FORMAT, utc)}\n`)
}
