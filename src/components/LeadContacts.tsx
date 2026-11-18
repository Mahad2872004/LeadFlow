import { useEffect, useMemo, useRef, useState } from 'react'
import { addApolloPeople, advanceContactSearch, assessContact, cancelContactSearch, channelTypeLabels, contactName, contactRoles, deleteContact, deleteLeadContactData, discoverContacts, emailStatusHelp,
  emailStatusLabels, howLabels, leadContacts, normalizePhone, outreachConfig, OutreachRequestError, phoneStatusLabels, resolveSuggestion, roleLabels, saveContact, setContactFlags, sourceLabels,
  verifyContacts, type ContactRole, type LeadContact, type LeadContacts, type OutreachConfig } from '../lib/outreach'
import { apolloReveal, apolloSearch, apolloStatus, type Person } from '../lib/apollo'
import { normalizeWebsite, type Lead } from '../lib/model'
import { dateLabel, initials } from '../lib/format'
import type { WorkspaceSummary } from '../lib/backend'
import { useAuth } from '../lib/session'
import { Icon } from './Icon'
import './Outreach.css'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Try again.'
const fieldLabels: Record<string, string> = { name: 'name', title: 'job title', email: 'email', phone: 'phone', whatsapp: 'WhatsApp number', linkedin: 'LinkedIn profile', profile: 'profile link' }
const providerNames: Record<string, string> = { site: 'Website', report: 'Business report', dns: 'Mail-server checks' }
const jobStatus: Record<string, string> = { pending: 'Waiting', running: 'Searching', completed: 'Completed', partial: 'Partly completed', failed: 'Failed', cancelled: 'Stopped' }
const domainOf = (website: string) => { try { return new URL(website).hostname.replace(/^www\./, '') } catch { return '' } }
type ContactAction = 'edit' | 'primary' | 'preferred' | 'confirm' | 'verify' | 'delete' | 'write' | { accept: boolean; index: number }
type Form = { id?: string; kind: 'person' | 'business'; fullName: string; label: string; jobTitle: string; role: ContactRole; email: string; phone: string; whatsapp: string; linkedinUrl: string; notes: string }
const blank: Form = { kind: 'person', fullName: '', label: '', jobTitle: '', role: 'owner', email: '', phone: '', whatsapp: '', linkedinUrl: '', notes: '' }

/** One contact: who it is, how to reach them, how trustworthy each detail is and where it came from. */
function ContactCard({ contact, website, canManage, busy, onAction }: {
  contact: LeadContact; website: string; canManage: boolean; busy: boolean
  onAction: (action: ContactAction) => void
}) {
  const confidence = assessContact(contact, website)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const name = contactName(contact)
  return <li className={`ow-contact${contact.isPreferred ? ' is-preferred' : ''}`}>
    <header>
      <span className={`ow-avatar ${contact.kind}`} aria-hidden="true">{contact.kind === 'person' ? initials(name) : <Icon name={contact.whatsapp ? 'chat' : contact.email ? 'mail' : 'phone'} size={17} />}</span>
      <div className="ow-contact-title">
        <h4>{name}</h4>
        <p>{[contact.jobTitle, contact.kind === 'person' || contact.role !== 'general' ? roleLabels[contact.role] : ''].filter(Boolean).join(' · ') || (contact.kind === 'business' ? 'Business contact' : 'Role not known')}</p>
      </div>
      <div className="ow-badges">
        {contact.isPrimary && <span className="ow-badge primary">Primary</span>}
        {contact.isPreferred && <span className="ow-badge preferred">Preferred for outreach</span>}
        {contact.confirmed && <span className="ow-badge confirmed"><Icon name="check" size={13} />Confirmed</span>}
        <span className={`ow-confidence ${confidence.level}`} title={[...confidence.reasons, ...confidence.limitations].join('\n')}>{confidence.level[0].toUpperCase() + confidence.level.slice(1)} confidence</span>
      </div>
    </header>
    <dl className="ow-details">
      {contact.email && <div><dt>Email</dt><dd><a href={`mailto:${contact.email}`}>{contact.email}</a> <span className={`ow-status email-${contact.emailStatus}`} title={contact.emailCheck?.detail || emailStatusHelp[contact.emailStatus]}>{emailStatusLabels[contact.emailStatus]}</span></dd></div>}
      {contact.phone && <div><dt>Phone</dt><dd><a href={`tel:${contact.phoneE164 || contact.phone}`}>{contact.phone}</a> <span className={`ow-status phone-${contact.phoneStatus}`} title={contact.phoneStatus === 'valid_format' ? 'Well formed for its country. This doesn’t confirm the line is in service.' : ''}>{phoneStatusLabels[contact.phoneStatus]}</span></dd></div>}
      {contact.whatsapp && <div><dt>WhatsApp</dt><dd>{contact.whatsapp} <span className="ow-status neutral" title="The business links to this number on WhatsApp, or your team entered it.">{contact.sources.some(source => source.field === 'whatsapp' && source.how === 'whatsapp_link') ? 'Published WhatsApp link' : 'Entered by your team'}</span></dd></div>}
      {(contact.linkedinUrl || contact.profileUrl) && <div><dt>Profile</dt><dd><a href={contact.linkedinUrl || contact.profileUrl} target="_blank" rel="noopener noreferrer nofollow">{(contact.linkedinUrl || contact.profileUrl).replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}</a></dd></div>}
      {contact.notes && <div><dt>Notes</dt><dd>{contact.notes}</dd></div>}
    </dl>
    {!!contact.suggestions.length && <div className="ow-suggestions" role="group" aria-label="Suggested changes">
      {contact.suggestions.map((suggestion, index) => <p key={`${suggestion.field}-${suggestion.value}`}><span>{sourceLabels[suggestion.source] ?? suggestion.source} now shows a different {fieldLabels[suggestion.field] ?? suggestion.field}: <strong>{suggestion.value}</strong></span>
        <button className="secondary" disabled={busy} onClick={() => onAction({ accept: true, index })}>Use it</button><button className="text-button" disabled={busy} onClick={() => onAction({ accept: false, index })}>Dismiss</button></p>)}
    </div>}
    <details className="ow-why">
      <summary>Sources and confidence</summary>
      {!!confidence.reasons.length && <ul className="ow-reasons">{confidence.reasons.map(reason => <li key={reason}><Icon name="check" size={14} />{reason}</li>)}</ul>}
      {!!confidence.limitations.length && <ul className="ow-limits">{confidence.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>}
      <ul className="ow-sources">{contact.sources.map((source, index) => <li key={index}><strong>{fieldLabels[source.field] ?? source.field}</strong> “{source.value}” · {sourceLabels[source.source] ?? source.source}, {howLabels[source.how] ?? source.how}
        {source.sourceUrl && <> · <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{source.sourceUrl.replace(/^https?:\/\//, '').slice(0, 50)}</a></>}{source.evidenceId && ' · cited in the business report'} · {dateLabel(source.observedAt)}</li>)}</ul>
      {contact.editedFields.length > 0 && <p className="br-muted">Edited by your team: {contact.editedFields.map(field => fieldLabels[field] ?? field).join(', ')}. Discovery never changes these.</p>}
    </details>
    <footer>
      <span className="br-muted">Updated {dateLabel(contact.updatedAt)}{contact.emailCheckedAt ? ` · email checked ${dateLabel(contact.emailCheckedAt)}` : ''}</span>
      <div className="ow-actions">
        <button className="primary" disabled={busy} onClick={() => onAction('write')}>Write outreach</button>
        <button className="secondary" disabled={busy} onClick={() => onAction('edit')}>Edit</button>
        <button className="secondary" disabled={busy} aria-pressed={contact.confirmed} onClick={() => onAction('confirm')}>{contact.confirmed ? 'Unconfirm' : 'Confirm'}</button>
        <button className="secondary" disabled={busy || contact.isPreferred} onClick={() => onAction('preferred')}>Prefer</button>
        <button className="secondary" disabled={busy || contact.isPrimary} onClick={() => onAction('primary')}>Make primary</button>
        {(contact.email || contact.phone) && <button className="secondary" disabled={busy} onClick={() => onAction('verify')}>Check again</button>}
        {canManage && (confirmDelete ? <span className="ow-confirm-inline">Delete and don’t collect it again? <button className="danger" disabled={busy} onClick={() => onAction('delete')}>Delete</button><button className="text-button" onClick={() => setConfirmDelete(false)}>Keep</button></span>
          : <button className="text-button ow-danger-link" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</button>)}
      </div>
    </footer>
  </li>
}

/** Contacts for one lead: discovery from its website and business report, Apollo decision-makers, and manual entries. */
export function LeadContacts({ workspace, lead, onWriteTo }: { workspace: WorkspaceSummary; lead: Lead; onWriteTo: (contactId: string) => void }) {
  const [data, setData] = useState<LeadContacts | null>(null)
  const [config, setConfig] = useState<OutreachConfig | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [confirmRecent, setConfirmRecent] = useState('')
  const [form, setForm] = useState<Form | null>(null), [formError, setFormError] = useState('')
  const [apollo, setApollo] = useState<{ accountId: string; people: Person[]; revealConfirm: string } | null>(null), [apolloError, setApolloError] = useState('')
  const [eraseConfirm, setEraseConfirm] = useState(false)
  const requestId = useRef(crypto.randomUUID())
  const website = normalizeWebsite(lead.website ?? ''), domain = domainOf(website)
  const { user } = useAuth()
  // Owners and admins delete any contact; members delete contacts they added themselves.
  const canManage = workspace.role !== 'member'
  useEffect(() => {
    let active = true
    leadContacts(workspace.id, lead.id).then(value => { if (active) setData(value) }).catch(cause => { if (active) { setData({ contacts: [], channels: [], job: null }); setError(errorText(cause)) } })
    outreachConfig(workspace.id).then(value => { if (active) setConfig(value) }).catch(() => { /* Informational. */ })
    return () => { active = false }
  }, [workspace.id, lead.id])
  // While a search runs, ask the server to run its next step. Closing the tab stops this; the worker continues it.
  const running = data?.job?.step ? data.job.id : null
  useEffect(() => {
    if (!running) return
    let active = true, failures = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await advanceContactSearch(workspace.id, lead.id, running)
        if (!active) return
        failures = 0; setData(next)
        if (!next.job?.step) { setNotice(next.job?.status === 'completed' ? `Contact search finished: ${next.job.progress.contactsAdded ?? 0} added, ${next.job.progress.contactsUpdated ?? 0} updated.` : next.job?.status === 'partial' ? 'Contact search finished, but some checks couldn’t run. See the details below.' : ''); return }
      } catch (cause) { failures++; if (active && failures >= 3) setError(errorText(cause)) }
      if (active) timer = setTimeout(tick, failures ? 8000 : 2000)
    }
    timer = setTimeout(tick, 800)
    return () => { active = false; clearTimeout(timer) }
  }, [running, workspace.id, lead.id])

  async function run(action: () => Promise<unknown>, success = '') {
    setBusy(true); setError(''); setNotice('')
    try { await action(); setData(await leadContacts(workspace.id, lead.id)); if (success) setNotice(success) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  async function discover(force = false) {
    setBusy(true); setError(''); setNotice(''); setConfirmRecent('')
    try {
      const result = await discoverContacts(workspace.id, { leadId: lead.id, requestId: requestId.current, force })
      requestId.current = crypto.randomUUID(); setData(result)
      if (result.existing) setNotice('A contact search for this lead was already running; showing it.')
    } catch (cause) {
      if (cause instanceof OutreachRequestError && cause.code === 'recent') { requestId.current = crypto.randomUUID(); setConfirmRecent(cause.message) }
      else { if (!(cause instanceof OutreachRequestError) || cause.status !== 0) requestId.current = crypto.randomUUID(); setError(errorText(cause)) }
    } finally { setBusy(false) }
  }
  async function act(contact: LeadContact, action: ContactAction) {
    if (action === 'write') return onWriteTo(contact.id)
    if (action === 'edit') { setFormError(''); setForm({ id: contact.id, kind: contact.kind, fullName: contact.fullName, label: contact.label, jobTitle: contact.jobTitle, role: contact.role, email: contact.email, phone: contact.phone, whatsapp: contact.whatsapp, linkedinUrl: contact.linkedinUrl || contact.profileUrl, notes: contact.notes }); return }
    if (action === 'verify') return run(async () => { const result = await verifyContacts(workspace.id, { leadId: lead.id, requestId: crypto.randomUUID(), contactIds: [contact.id] }); setData(result) })
    if (action === 'delete') return run(() => deleteContact(workspace.id, contact.id), `${contactName(contact)} was deleted. Discovery won’t add it again.`)
    if (typeof action === 'object') return run(() => resolveSuggestion(workspace.id, contact.id, contact.suggestions[action.index], action.accept), action.accept ? 'Suggestion applied. Discovery won’t change that field again.' : 'Suggestion dismissed.')
    const flags = action === 'confirm' ? { confirmed: !contact.confirmed } : action === 'primary' ? { primary: true } : { preferred: true }
    return run(() => setContactFlags(workspace.id, contact.id, flags))
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    const phone = form.phone.trim() ? normalizePhone(form.phone, lead.country ?? '') : null
    const whatsapp = form.whatsapp.trim() ? normalizePhone(form.whatsapp, lead.country ?? '') : null
    if (form.kind === 'person' && !form.fullName.trim()) return setFormError('Enter the person’s name.')
    if (phone?.status === 'invalid_format') return setFormError(`“${form.phone}” isn’t a valid phone number${lead.country ? ` for ${lead.country}` : ''}.`)
    if (whatsapp && !whatsapp.e164) return setFormError('Enter the WhatsApp number in international format, such as +15125550100.')
    const linkedin = form.linkedinUrl.trim()
    if (linkedin && !/^https?:\/\//i.test(linkedin)) return setFormError('Profile links must start with https://.')
    setBusy(true); setFormError('')
    try {
      await saveContact(workspace.id, lead.id, { ...(form.id ? { id: form.id } : {}), kind: form.kind, fullName: form.fullName.trim(), label: form.label.trim(), jobTitle: form.jobTitle.trim(), role: form.role, email: form.email.trim().toLowerCase(),
        phone: phone ? phone.national || phone.original : '', phoneE164: phone?.e164 ?? '', phoneStatus: phone?.status === 'valid_format' ? 'valid_format' : 'unverified', whatsapp: whatsapp?.e164 ?? '', linkedinUrl: linkedin, notes: form.notes.trim() })
      setForm(null); setData(await leadContacts(workspace.id, lead.id)); setNotice(form.id ? 'Contact updated. The fields you changed are protected from discovery.' : 'Contact added.')
    } catch (cause) { setFormError(errorText(cause)) } finally { setBusy(false) }
  }
  async function findDecisionMakers() {
    setBusy(true); setApolloError('')
    try {
      const status = await apolloStatus(workspace.id)
      const account = status.accounts.find(item => item.active && item.configured)
      if (!status.enabled || !account) throw new Error(status.reason === 'workspace_not_enabled' ? 'Apollo isn’t switched on for this workspace.' : 'No active Apollo account is configured.')
      // People search is free in Apollo (no credits); results are saved for the workspace.
      const page = await apolloSearch(workspace.id, { kind: 'people', accountId: account.id, filters: { domains: [domain], seniorities: ['owner', 'founder', 'c_suite', 'partner', 'head', 'director'] }, page: 1, perPage: 10 })
      setApollo({ accountId: account.id, people: page.items, revealConfirm: '' })
    } catch (cause) { setApolloError(errorText(cause)) } finally { setBusy(false) }
  }
  async function addFromApollo(person: Person, reveal: boolean) {
    if (!apollo) return
    setBusy(true); setApolloError('')
    try {
      if (reveal) await apolloReveal(workspace.id, { accountId: apollo.accountId, operationId: crypto.randomUUID(), people: [{ id: person.id, name: person.name }], phone: false })
      const result = await addApolloPeople(workspace.id, lead.id, [person.id])
      setApollo({ ...apollo, revealConfirm: '' }); setData(await leadContacts(workspace.id, lead.id))
      setNotice(result.added ? `${person.name} was added from Apollo.` : `${person.name} was already a contact; their details were updated.`)
    } catch (cause) { setApolloError(errorText(cause)) } finally { setBusy(false) }
  }
  const counts = useMemo(() => ({ people: data?.contacts.filter(item => item.kind === 'person').length ?? 0, business: data?.contacts.filter(item => item.kind === 'business').length ?? 0 }), [data])
  if (!data) return <div className="br-loading" role="status"><span className="sr-only">Loading contacts…</span><i className="skeleton skeleton-title" /><i className="skeleton skeleton-panel" /></div>
  const job = data.job, active = !!job?.step

  return <div className="ow">
    <section className="ow-intro">
      <div>
        <h3>Contacts</h3>
        <p className="br-muted">Public contact details from {domain ? <strong>{domain}</strong> : 'the lead record'} and its business report, people your team adds, and Apollo decision-makers if your workspace uses Apollo. Every detail shows where it came from and how reliable it is.</p>
      </div>
      <div className="ow-intro-actions">
        <button className="primary" disabled={busy || active} onClick={() => void discover()}>{active ? 'Searching…' : data.contacts.length ? 'Search again' : 'Find contacts'}</button>
        <button className="secondary" disabled={busy} onClick={() => { setFormError(''); setForm({ ...blank }) }}><Icon name="plus" size={15} />Add contact</button>
      </div>
    </section>
    <p className="br-muted ow-policy"><Icon name="check" size={14} />Only public pages are read and robots.txt is respected. Logins, CAPTCHAs and bot protection are never bypassed, no email pattern is guessed, and nothing is sent to any address.</p>
    {notice && <p className="br-notice" role="status">{notice}</p>}
    {error && <p className="br-error" role="alert">{error}</p>}
    {confirmRecent && <div className="br-confirm" role="alert"><p>{confirmRecent}</p><div className="br-actions"><button className="secondary" onClick={() => setConfirmRecent('')}>Keep the current results</button><button className="primary" disabled={busy} onClick={() => void discover(true)}>Search again anyway</button></div></div>}
    {job && <div className={`ow-job ${job.status}`} role="status" aria-live="polite">
      <div><strong>{job.mode === 'verify' ? 'Checking contact details' : 'Contact search'}: {jobStatus[job.status]}{active ? '…' : ''}</strong>
        <span className="br-muted">{dateLabel(job.createdAt)}{job.progress.pagesRead !== undefined ? ` · ${job.progress.pagesRead} page${job.progress.pagesRead === 1 ? '' : 's'} read` : ''}{job.progress.contactsAdded !== undefined ? ` · ${job.progress.contactsAdded} added, ${job.progress.contactsUpdated ?? 0} updated` : ''}{job.progress.suggestions ? ` · ${job.progress.suggestions} suggestion${job.progress.suggestions === 1 ? '' : 's'}` : ''}</span></div>
      {active && <button className="text-button" disabled={busy} onClick={() => void run(() => cancelContactSearch(workspace.id, job.id), 'Contact search stopped.')}>Stop</button>}
      {job.failure && <p className="ow-job-failure">{job.failure}</p>}
      {!!Object.keys(job.providers).length && <ul className="ow-providers">{Object.entries(job.providers).map(([name, state]) => <li key={name} className={state.status}><strong>{providerNames[name] ?? name}:</strong> {state.detail ?? state.status}</li>)}</ul>}
    </div>}

    {form && <form className="ow-form" onSubmit={save} aria-label={form.id ? 'Edit contact' : 'Add a contact'}>
      <h4>{form.id ? `Edit ${contactName(data.contacts.find(item => item.id === form.id) ?? { kind: form.kind, fullName: form.fullName, label: form.label, email: form.email, phone: form.phone })}` : 'Add a contact'}</h4>
      {!form.id && <div className="ow-segmented" role="radiogroup" aria-label="Contact type">{(['person', 'business'] as const).map(kind => <label key={kind}><input type="radio" name="kind" checked={form.kind === kind} onChange={() => setForm({ ...form, kind, role: kind === 'person' ? 'owner' : 'general' })} />{kind === 'person' ? 'A person' : 'A business inbox or line'}</label>)}</div>}
      <div className="ow-form-grid">
        {form.kind === 'person' ? <label>Name *<input value={form.fullName} maxLength={150} onChange={event => setForm({ ...form, fullName: event.target.value })} /></label>
          : <label>Label<input value={form.label} maxLength={80} placeholder="General inquiries" onChange={event => setForm({ ...form, label: event.target.value })} /></label>}
        {form.kind === 'person' && <label>Job title<input value={form.jobTitle} maxLength={150} onChange={event => setForm({ ...form, jobTitle: event.target.value })} /></label>}
        <label>Role<select value={form.role} onChange={event => setForm({ ...form, role: event.target.value as ContactRole })}>{contactRoles.map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>
        <label>Email<input type="email" value={form.email} maxLength={150} onChange={event => setForm({ ...form, email: event.target.value })} /></label>
        <label>Phone<input type="tel" value={form.phone} maxLength={40} placeholder={lead.country ? `A ${lead.country} number or +country code` : '+country code and number'} onChange={event => setForm({ ...form, phone: event.target.value })} /></label>
        <label>WhatsApp number<input type="tel" value={form.whatsapp} maxLength={40} placeholder="Only if you know it uses WhatsApp" onChange={event => setForm({ ...form, whatsapp: event.target.value })} /></label>
        <label>LinkedIn or profile link<input type="url" value={form.linkedinUrl} maxLength={300} placeholder="https://www.linkedin.com/in/…" onChange={event => setForm({ ...form, linkedinUrl: event.target.value })} /></label>
        <label className="ow-wide">Notes<textarea rows={2} maxLength={2000} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
      </div>
      {form.id && <p className="br-muted">Fields you change here are protected: later searches suggest differences instead of overwriting them. The originally discovered values stay in the sources.</p>}
      {formError && <p className="field-error" role="alert">{formError}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button><button className="primary" disabled={busy}>{form.id ? 'Save contact' : 'Add contact'}</button></div>
    </form>}

    {data.contacts.length ? <>
      <p className="ow-count">{counts.people} {counts.people === 1 ? 'person' : 'people'} · {counts.business} business {counts.business === 1 ? 'contact' : 'contacts'}</p>
      <ul className="ow-contacts">{data.contacts.map(contact => <ContactCard key={contact.id} contact={contact} website={website} busy={busy}
        canManage={canManage || (contact.origin === 'manual' && contact.createdBy === user.id)} onAction={action => void act(contact, action)} />)}</ul>
    </> : !active && <div className="ow-empty"><span className="ow-empty-icon" aria-hidden="true"><Icon name="users" size={22} /></span><h4>No contacts yet</h4>
      <p>{website ? 'Find contacts reads the website’s contact, team and about pages and the latest business report.' : 'This lead has no website. Add a contact by hand, or add a website to the lead to search it.'}</p></div>}

    {!!data.channels.length && <section className="ow-channels"><h4>Business channels</h4><ul>{data.channels.map(channel => <li key={channel.id}><span>{channelTypeLabels[channel.channel]}{channel.label && channel.label !== channelTypeLabels[channel.channel] ? ` · ${channel.label}` : ''}</span>
      {/^https?:\/\//.test(channel.value) ? <a href={channel.value} target="_blank" rel="noopener noreferrer nofollow">{channel.value.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}</a> : <strong>{channel.value}</strong>}
      <small className="br-muted">{sourceLabels[channel.source] ?? channel.source}{channel.evidenceId ? ' · in the business report' : ''}</small></li>)}</ul></section>}

    {config?.providers.apollo.enabled && domain && <section className="ow-apollo">
      <div className="ow-apollo-head"><div><h4>Decision-makers from Apollo</h4><p className="br-muted">Searches Apollo for owners, founders, executives and directors at {domain}. Searching is free; revealing an email uses 1 Apollo credit and asks first.</p></div>
        <button className="secondary" disabled={busy} onClick={() => void findDecisionMakers()}>{apollo ? 'Search again' : 'Search Apollo'}</button></div>
      {apolloError && <p className="br-error" role="alert">{apolloError}</p>}
      {apollo && (apollo.people.length ? <ul className="ow-apollo-list">{apollo.people.map(person => <li key={person.id}>
        <div><strong>{person.name}</strong><span className="br-muted">{person.title || 'Title not shown'}{person.hasEmail ? ' · email available' : ' · no email in Apollo'}</span></div>
        {apollo.revealConfirm === person.id ? <span className="ow-confirm-inline">Use 1 Apollo credit? <button className="primary" disabled={busy} onClick={() => void addFromApollo(person, true)}>Reveal and add</button><button className="text-button" onClick={() => setApollo({ ...apollo, revealConfirm: '' })}>Cancel</button></span>
          : <div className="ow-actions"><button className="secondary" disabled={busy} onClick={() => void addFromApollo(person, false)}>Add (name partly hidden)</button>{person.hasEmail && <button className="secondary" disabled={busy} onClick={() => setApollo({ ...apollo, revealConfirm: person.id })}>Reveal email…</button>}</div>}
      </li>)}</ul> : <p className="br-muted">Apollo has no decision-makers listed for {domain}.</p>)}
    </section>}

    {canManage && data.contacts.length > 0 && <div className="ow-erase">{eraseConfirm ? <span className="ow-confirm-inline">Delete every contact, source and channel for this lead? Drafts keep their text. <button className="danger" disabled={busy} onClick={() => void run(() => deleteLeadContactData(workspace.id, lead.id), 'This lead’s contact data was deleted.').then(() => setEraseConfirm(false))}>Delete contact data</button><button className="text-button" onClick={() => setEraseConfirm(false)}>Cancel</button></span>
      : <button className="text-button ow-danger-link" onClick={() => setEraseConfirm(true)}>Delete all contact data for this lead…</button>}</div>}
  </div>
}
