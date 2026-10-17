/** Calendar dates are local YYYY-MM-DD values, never UTC timestamps. */
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
export function isCalendarDate(value: string): boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year,month,day]=value.split('-').map(Number)
  if(year<1 || month<1 || month>12 || day<1) return false
  const leap=year%4===0&&(year%100!==0||year%400===0)
  return day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]
}
export type TaskState = 'Completed' | 'Overdue' | 'Due today' | 'Upcoming'
export function taskState(task:{due:string;completed:boolean},day=localDate()):TaskState {
  if(task.completed) return 'Completed'
  return task.due<day?'Overdue':task.due===day?'Due today':'Upcoming'
}
export function isTaskDue(task:{due:string;completed:boolean},day=localDate()):boolean {
  return !task.completed&&isCalendarDate(task.due)&&task.due<=day
}
