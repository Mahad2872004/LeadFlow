import { useEffect, useState } from 'react'
import { today, leadTaskTypes, priorities, type Lead, type Priority, type TaskOptions, type TaskType } from '../lib/model'
import { dealsFor, priorityLabels, taskTypeLabels, type Deal, type SalesMember } from '../lib/sales'

/**
 * Plans a follow-up: the one task system, used for leads and (since M9) deals. Tasks are reminders inside LeadFlow;
 * nothing is sent. Deals and members load from the database when it's available; the form works without them.
 */
export function TaskForm({ workspaceId, leads, initialLeadId, fixedDeal, members, contacts, onSubmit, onCancel }: {
  workspaceId?: string; leads: Lead[]; initialLeadId: string; fixedDeal?: Pick<Deal, 'id' | 'title' | 'leadId'>
  members?: SalesMember[]; contacts?: { id: string; name: string }[]
  onSubmit: (leadId: string, due: string, notes: string, options: TaskOptions) => Promise<boolean>; onCancel: () => void
}) {
  const [leadId, setLeadId] = useState(fixedDeal?.leadId ?? initialLeadId), [due, setDue] = useState(today()), [notes, setNotes] = useState('')
  const [taskType, setTaskType] = useState<TaskType>('follow_up'), [priority, setPriority] = useState<Priority>('medium'), [description, setDescription] = useState('')
  const [dealId, setDealId] = useState(fixedDeal?.id ?? ''), [assigneeId, setAssigneeId] = useState(''), [contactId, setContactId] = useState('')
  const [deals, setDeals] = useState<Deal[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  // The lead's open deals, so a lead follow-up can be tied to one. Optional: without the pipeline the list stays empty.
  useEffect(() => {
    if (fixedDeal || !workspaceId || !leadId) return
    let active = true
    dealsFor(workspaceId, { leadId, outcome: 'open', limit: 50 }).then(page => { if (active) setDeals(page.items) }).catch(() => { if (active) setDeals([]) })
    return () => { active = false }
  }, [workspaceId, leadId, fixedDeal])
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const options: TaskOptions = { taskType, priority, description: description.trim() || undefined, dealId: dealId || undefined, assigneeId: assigneeId || undefined, contactId: contactId || undefined }
      await onSubmit(leadId, due, notes, options)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create task.') } finally { setBusy(false) }
  }
  if (!leads.length) return null
  return <form className="task-form" onSubmit={submit}>
    {fixedDeal ? <p className="muted">For the deal <strong>{fixedDeal.title}</strong>.</p>
      : <label>Lead *<select value={leadId} required onChange={event => { setLeadId(event.target.value); setDealId('') }}>{leads.map(lead => <option key={lead.id} value={lead.id}>{lead.name} · {lead.company || lead.email}</option>)}</select></label>}
    {!fixedDeal && deals.length > 0 && <label>Deal<select value={dealId} onChange={event => setDealId(event.target.value)}><option value="">Not linked to a deal</option>{deals.map(deal => <option key={deal.id} value={deal.id}>{deal.title}</option>)}</select></label>}
    <div className="task-form-row">
      <label>Type<select value={taskType} onChange={event => setTaskType(event.target.value as TaskType)}>{leadTaskTypes.map(type => <option key={type} value={type}>{taskTypeLabels[type]}</option>)}</select></label>
      <label>Priority<select value={priority} onChange={event => setPriority(event.target.value as Priority)}>{priorities.map(item => <option key={item} value={item}>{priorityLabels[item]}</option>)}</select></label>
    </div>
    <label>Due date *<input type="date" required min="0001-01-01" max="9999-12-31" aria-describedby="due-date-help" value={due} onChange={event => setDue(event.target.value)} /></label>
    <p id="due-date-help" className="muted">Dates use your local calendar. Past dates are allowed and marked overdue; tasks due today become overdue tomorrow.</p>
    <label>Notes *<textarea required maxLength={2000} rows={3} placeholder="What’s the next step?" value={notes} onChange={event => setNotes(event.target.value)} /></label>
    {(!!members?.length || !!contacts?.length) && <div className="task-form-row">
      {!!members?.length && <label>Assigned to<select value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
      {!!contacts?.length && <label>Contact<select value={contactId} onChange={event => setContactId(event.target.value)}><option value="">None</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select></label>}
    </div>}
    <label>Details<textarea maxLength={2000} rows={2} placeholder="Optional: talking points, links, what to prepare" value={description} onChange={event => setDescription(event.target.value)} /></label>
    <p className="muted">A reminder inside LeadFlow. Nothing is sent to anyone.</p>
    {error && <p role="alert" className="field-error">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy}>Schedule follow-up</button></div>
  </form>
}
