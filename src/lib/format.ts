/** Show the year as well, so past/future follow-ups cannot be mistaken for this year's dates. */
export const dateLabel = (date: string) => new Date(date.length === 10 ? `${date}T12:00:00` : date).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})
/** Up to two letters for an avatar, e.g. "Northline Studio" → "NS". */
export const initials = (name: string) => name.trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('') || '?'
