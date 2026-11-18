import { localDate } from './dates'
import type { Lead } from './model'

/** The `days` local calendar dates ending at `day` (YYYY-MM-DD), oldest first. */
export function lastDays(day: string, days: number): string[] {
  const [year, month, date] = day.split('-').map(Number)
  return Array.from({ length: days }, (_, index) => localDate(new Date(year, month - 1, date - (days - 1 - index))))
}

const createdOn = (lead: Lead) => {
  const created = new Date(lead.createdAt)
  return Number.isNaN(created.getTime()) ? '' : localDate(created)
}

/** How many leads were added on each of the last `days` days. */
export function leadsPerDay(leads: Lead[], day: string, days = 14): number[] {
  const dates = lastDays(day, days)
  const position = new Map(dates.map((date, index) => [date, index]))
  const counts = dates.map(() => 0)
  for (const lead of leads) {
    const index = position.get(createdOn(lead))
    if (index !== undefined) counts[index]++
  }
  return counts
}

/** The size of the pipeline at the end of each of the last `days` days. */
export function runningTotal(leads: Lead[], day: string, days = 14): number[] {
  const created = leads.map(createdOn).filter(Boolean)
  return lastDays(day, days).map(date => created.filter(value => value <= date).length)
}

/** "Thursday, 19 November" for a local YYYY-MM-DD date. */
export function longDayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}
