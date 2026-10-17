/** Show the year as well, so past/future follow-ups cannot be mistaken for this year's dates. */
export const dateLabel = (date: string) => new Date(date.length === 10 ? `${date}T12:00:00` : date).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})
