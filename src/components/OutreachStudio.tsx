import { useEffect, useMemo, useRef, useState } from 'react'
import { analysesFor, analysisReport, opportunityLabels, type Report } from '../lib/analysis'
import { angleDefinitions, channelHelp, channelLabels, channelLimits, contactName, deleteDraft, diffWords, draftStatusLabels, draftsFor, draftVersions, duplicateDraft, followUpDates, generateDraft,
  lengthLabels, leadContacts, mailtoLink, objectiveLabels, originLabels, outreachAngles, outreachChannels, outreachConfig, outreachPreferences, OutreachRequestError, recommendOutreach, restoreVersion,
  saveDraft, setDraftStatus, toneLabels, whatsappLink, type Draft, type DraftStatus, type DraftVersion, type LeadContact, type OutreachAngle, type OutreachChannel, type OutreachConfig, type Preferences } from '../lib/outreach'
import type { Lead } from '../lib/model'
import { dateLabel } from '../lib/format'
import type { WorkspaceSummary } from '../lib/backend'
import { Icon, type IconName } from './Icon'
import './Outreach.css'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Try again.'
const channelIcons: Record<OutreachChannel, IconName> = { email: 'mail', whatsapp: 'chat', linkedin_connection: 'users', linkedin_message: 'chat' }
const statusFilters: [string, string][] = [['active', 'Active'], ['draft', 'Drafts'], ['ready', 'Ready to send'], ['sent', 'Sent'], ['replied', 'Replied'], ['follow_up', 'Follow-up required'], ['archived', 'Archived'], ['all', 'All']]
interface Compose { opportunityId: string; contactId: string; channel: OutreachChannel; angle: OutreachAngle; instructions: string; sequenceStep: number; parentId: string | null }
const titleOf = (draft: Draft) => draft.subject || draft.body.split('\n').find(line => line.trim())?.slice(0, 70) || 'Untitled draft'
const channelFor = (contact: LeadContact | undefined): OutreachChannel => !contact || contact.email ? 'email' : contact.whatsapp ? 'whatsapp' : contact.linkedinUrl ? 'linkedin_connection' : 'email'

/** The version history of a draft, with a word-level comparison against the current text and a restore action. */
function Versions({ workspaceId, draft, busy, onRestore }: { workspaceId: string; draft: Draft; busy: boolean; onRestore: (version: number) => void }) {
  // Keyed by draft and version in the parent, so a new version starts with fresh state.
  const [versions, setVersions] = useState<DraftVersion[] | null>(null), [compare, setCompare] = useState<number | null>(null), [error, setError] = useState('')
  useEffect(() => { let active = true; draftVersions(workspaceId, draft.id).then(items => { if (active) setVersions(items) }).catch(cause => { if (active) setError(errorText(cause)) }); return () => { active = false } }, [workspaceId, draft.id])
  const compared = versions?.find(item => item.version === compare)
  const parts = useMemo(() => compared ? diffWords(`${compared.subject ? `${compared.subject}\n\n` : ''}${compared.body}`, `${draft.subject ? `${draft.subject}\n\n` : ''}${draft.body}`) : [], [compared, draft.subject, draft.body])
  return <details className="ow-versions">
    <summary><Icon name="history" size={15} />Version history ({draft.version})</summary>
    {error && <p className="br-error" role="alert">{error}</p>}
    {!versions ? <p className="br-muted">Loading…</p> : <ol>{versions.map(item => <li key={item.version} className={item.version === draft.version ? 'current' : ''}>
      <span><strong>Version {item.version}</strong> · {originLabels[item.origin]} · {dateLabel(item.createdAt)}{item.model ? ` · ${item.model}` : ''}{item.version === draft.version ? ' · current' : ''}</span>
      {item.version !== draft.version && <span className="ow-actions"><button className="text-button" aria-pressed={compare === item.version} onClick={() => setCompare(compare === item.version ? null : item.version)}>{compare === item.version ? 'Hide comparison' : 'Compare with current'}</button>
        <button className="text-button" disabled={busy || ['sent', 'replied'].includes(draft.status)} onClick={() => onRestore(item.version)}>Restore</button></span>}
    </li>)}</ol>}
    {compared && <div className="ow-diff" aria-label={`Changes from version ${compared.version} to the current version`}>{parts.map((part, index) => part.type === 'same' ? <span key={index}>{part.text}</span>
      : part.type === 'added' ? <ins key={index}>{part.text}</ins> : <del key={index}>{part.text}</del>)}</div>}
  </details>
}

/**
 * Outreach for one lead: choose an opportunity, a contact, a channel and an angle; generate a draft grounded in the
 * business report; edit, save, copy and track it. Nothing is sent from LeadFlow, and "sent" is only ever set by a person.
 */
export function OutreachStudio({ workspace, lead, initialContactId, onPlanFollowUp, onLogActivity, onShowContacts, onShowReport }: {
  workspace: WorkspaceSummary; lead: Lead; initialContactId: string | null
  onPlanFollowUp: (due: string, notes: string) => Promise<boolean>; onLogActivity: (text: string) => Promise<boolean>; onShowContacts: () => void; onShowReport: () => void
}) {
  const [contacts, setContacts] = useState<LeadContact[] | null>(null), [report, setReport] = useState<Report | null>(null), [drafts, setDrafts] = useState<Draft[]>([])
  const [preferences, setPreferences] = useState<Preferences | null>(null), [config, setConfig] = useState<OutreachConfig | null>(null)
  const [compose, setCompose] = useState<Compose | null>(null), [selected, setSelected] = useState<string | null>(null), [filter, setFilter] = useState('active')
  const [subject, setSubject] = useState(''), [body, setBody] = useState(''), [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{ kind: 'regenerate' | 'sent' | 'delete'; message: string } | null>(null), [regenerateAngle, setRegenerateAngle] = useState<OutreachAngle>('opportunity')
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    let active = true
    Promise.all([leadContacts(workspace.id, lead.id), draftsFor(workspace.id, lead.id), outreachPreferences(workspace.id),
      analysesFor(workspace.id, lead.id).then(items => { const latest = items.find(item => item.status === 'completed' || item.status === 'partial'); return latest ? analysisReport(workspace.id, latest.id) : null })])
      .then(([contactData, draftList, settings, latestReport]) => {
        if (!active) return
        setContacts(contactData.contacts); setDrafts(draftList); setPreferences(settings.effective); setReport(latestReport)
        const recommended = recommendOutreach({ opportunities: latestReport?.opportunities ?? [], findings: latestReport?.findings ?? [] })
        const contact = contactData.contacts.find(item => item.id === initialContactId) ?? contactData.contacts.find(item => item.isPreferred) ?? contactData.contacts.find(item => item.isPrimary) ?? contactData.contacts.find(item => item.email) ?? contactData.contacts[0]
        setCompose({ opportunityId: recommended.opportunityId ?? '', contactId: contact?.id ?? '', channel: channelFor(contact), angle: recommended.angle, instructions: '', sequenceStep: 0, parentId: null })
        if (draftList[0]) setSelected(draftList[0].id)
      }).catch(cause => { if (active) { setContacts([]); setError(errorText(cause)) } })
    outreachConfig(workspace.id).then(value => { if (active) setConfig(value) }).catch(() => { /* Informational. */ })
    return () => { active = false }
  }, [workspace.id, lead.id, initialContactId])
  const draft = drafts.find(item => item.id === selected) ?? null
  // When another draft or a new version is shown, the editor starts from its saved text.
  const draftKey = draft ? `${draft.id}:${draft.version}` : '', [editing, setEditing] = useState(draftKey)
  if (editing !== draftKey) { setEditing(draftKey); setSubject(draft?.subject ?? ''); setBody(draft?.body ?? ''); setNotes(draft?.notes ?? ''); setConfirm(null); setRegenerateAngle(draft?.angle ?? 'opportunity') }
  const recommendation = useMemo(() => recommendOutreach({ opportunities: report?.opportunities ?? [], findings: report?.findings ?? [] }), [report])
  const findings = useMemo(() => new Map((report?.findings ?? []).map(item => [item.id, item])), [report])
  const dirty = !!draft && (subject !== draft.subject || body !== draft.body)
  const replace = (next: Draft) => setDrafts(items => items.some(item => item.id === next.id) ? items.map(item => item.id === next.id ? next : item) : [next, ...items])

  async function guarded(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  async function generate(regenerate?: { draft: Draft; replaceEdited: boolean }) {
    if (!compose) return
    setBusy(true); setError(''); setNotice(''); setConfirm(null)
    const source = regenerate?.draft
    try {
      const next = await generateDraft(workspace.id, {
        leadId: lead.id, requestId: requestId.current, channel: source?.channel ?? compose.channel, angle: source ? regenerateAngle : compose.angle,
        opportunityId: source ? source.opportunityId : compose.opportunityId || null, contactId: source ? source.contactId : compose.contactId || null,
        sequenceStep: source?.sequenceStep ?? compose.sequenceStep, parentId: source?.parentId ?? compose.parentId, instructions: compose.instructions.trim(),
        ...(source ? { draftId: source.id, expectedVersion: source.version, replaceEdited: regenerate.replaceEdited } : {}),
      })
      requestId.current = crypto.randomUUID()
      replace(next); setSelected(next.id)
      if (!source) setCompose({ ...compose, sequenceStep: 0, parentId: null })
      setNotice(source ? `Version ${next.version} generated. Earlier versions are in the history.` : 'Draft ready. Review and edit it before sending it yourself.')
    } catch (cause) {
      if (cause instanceof OutreachRequestError && cause.code === 'edited' && source) { requestId.current = crypto.randomUUID(); setConfirm({ kind: 'regenerate', message: cause.message }) }
      else { if (!(cause instanceof OutreachRequestError) || cause.status !== 0) requestId.current = crypto.randomUUID(); setError(errorText(cause)) }
    } finally { setBusy(false) }
  }
  async function save() {
    if (!draft) return
    await guarded(async () => { const next = await saveDraft(workspace.id, draft.id, draft.version, { subject, body }); replace(next); setNotice(`Saved as version ${next.version}.`) })
  }
  async function status(next: DraftStatus) {
    if (!draft) return
    await guarded(async () => {
      const updated = await setDraftStatus(workspace.id, draft.id, next); replace(updated); setConfirm(null)
      if (next === 'sent') {
        const to = draft.contactName ? ` to ${draft.contactName}` : ''
        // The draft is marked either way; the activity entry goes through the workspace's normal save, which can be retried.
        if (await onLogActivity(`${channelLabels[draft.channel]} marked as sent manually${to}: “${titleOf(draft).slice(0, 80)}”`)) setNotice('Marked as sent. Add a reminder below if you want to follow up.')
        else setError('Marked as sent, but the lead’s activity history couldn’t be updated. Close this window and choose Retry saving.')
      } else setNotice(`Marked as ${draftStatusLabels[next].toLowerCase()}.`)
    })
  }
  async function copy() {
    if (!draft) return
    const text = draft.channel === 'email' && subject ? `Subject: ${subject}\n\n${body}` : body
    try { await navigator.clipboard.writeText(text); setNotice(`Copied${dirty ? ' (including unsaved changes)' : ''}. It isn’t marked as sent: do that after you’ve sent it.`) }
    catch { setError('Your browser didn’t allow copying. Select the text and copy it yourself.') }
  }
  function followUp() {
    if (!draft || !compose) return
    const root = draft.parentId ? drafts.find(item => item.id === draft.parentId) ?? draft : draft
    const step = Math.min(3, drafts.filter(item => item.parentId === root.id).length + 1)
    setCompose({ ...compose, channel: draft.channel === 'linkedin_connection' ? 'linkedin_message' : draft.channel, contactId: draft.contactId ?? '', opportunityId: draft.opportunityId ?? '', angle: 'consultative', sequenceStep: step, parentId: root.id })
    setNotice(`Follow-up ${step} is set up in the composer. Choose Generate draft when you’re ready.`)
    document.getElementById('ow-compose')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  if (!contacts || !compose || !preferences) return error ? <p className="br-error" role="alert">{error}</p> : <div className="br-loading" role="status"><span className="sr-only">Loading outreach…</span><i className="skeleton skeleton-title" /><i className="skeleton skeleton-panel" /></div>
  const contact = contacts.find(item => item.id === compose.contactId)
  const opportunities = (report?.opportunities ?? []).filter(item => item.status !== 'dismissed')
  const parent = compose.parentId ? drafts.find(item => item.id === compose.parentId) : null
  const visible = drafts.filter(item => filter === 'all' || (filter === 'active' ? item.status !== 'archived' : item.status === filter))
  const draftContact = draft ? contacts.find(item => item.id === draft.contactId) : undefined
  const limit = draft ? (config?.channelLimits ?? channelLimits)[draft.channel].body : 0
  const reminders = draft?.sentAt && ['sent', 'follow_up'].includes(draft.status) ? followUpDates(draft.sentAt, preferences.followupIntervals) : []
  const aiOff = config?.providers.ai.configured === false

  return <div className="ow ow-studio">
    {notice && <p className="br-notice" role="status">{notice}</p>}
    {error && <p className="br-error" role="alert">{error}</p>}
    <div className="ow-studio-grid">
      <section className="ow-compose" id="ow-compose" aria-labelledby="ow-compose-title">
        <h3 id="ow-compose-title">{parent ? `Follow-up ${compose.sequenceStep}` : 'Write outreach'}</h3>
        {parent && <p className="ow-followup-note">Following up on “{titleOf(parent)}”, sent {parent.sentAt ? dateLabel(parent.sentAt) : ''}. <button className="text-button" onClick={() => setCompose({ ...compose, sequenceStep: 0, parentId: null })}>Write a first message instead</button></p>}
        {!report && <p className="br-notice">No business report for this lead yet, so drafts will be honest general introductions. <button className="text-button" onClick={onShowReport}>Open the business report</button></p>}
        {aiOff && <p className="br-error">AI drafting isn’t set up: add a Gemini API key (GEMINI_API_KEY) to the Edge Function secrets. You can still edit and track drafts.</p>}
        <label>Opportunity<select value={compose.opportunityId} onChange={event => setCompose({ ...compose, opportunityId: event.target.value })}>
          <option value="">General introduction (no specific opportunity)</option>
          {opportunities.map(item => <option key={item.id} value={item.id}>{item.id === recommendation.opportunityId ? '★ ' : ''}{item.title} · {item.priority} priority{item.serviceId ? ` · ${item.serviceName}` : ''}</option>)}
        </select></label>
        {compose.opportunityId && (() => { const item = opportunities.find(opportunity => opportunity.id === compose.opportunityId); return item ? <p className="br-muted ow-hint">{opportunityLabels[item.opportunityType]} · {item.confidence} confidence{item.status === 'accepted' ? ' · accepted by your team' : item.status === 'needs_verification' ? ' · needs verification' : ''}. {item.why}</p> : null })()}
        <label>Contact<select value={compose.contactId} onChange={event => { const next = contacts.find(item => item.id === event.target.value); setCompose({ ...compose, contactId: event.target.value, channel: compose.parentId ? compose.channel : channelFor(next) }) }}>
          <option value="">No specific contact</option>
          {contacts.map(item => <option key={item.id} value={item.id}>{item.isPreferred ? '★ ' : ''}{contactName(item)}{item.jobTitle ? ` · ${item.jobTitle}` : ''}{item.email ? ` · ${item.email}` : item.whatsapp ? ` · ${item.whatsapp}` : item.phone ? ` · ${item.phone}` : ''}</option>)}
        </select></label>
        {!contacts.length && <p className="br-muted ow-hint">No contacts yet. <button className="text-button" onClick={onShowContacts}>Find or add contacts</button></p>}
        <fieldset className="ow-channel"><legend>Channel</legend>{outreachChannels.map(channel => <label key={channel} className={compose.channel === channel ? 'on' : ''}>
          <input type="radio" name="ow-channel" checked={compose.channel === channel} disabled={!!parent && channel === 'linkedin_connection'} onChange={() => setCompose({ ...compose, channel })} /><Icon name={channelIcons[channel]} size={15} />{channelLabels[channel]}</label>)}</fieldset>
        <p className="br-muted ow-hint">{channelHelp[compose.channel]}{compose.channel === 'email' && contact && !contact.email ? ' This contact has no email address.' : ''}{compose.channel === 'whatsapp' && contact && !contact.whatsapp ? ' This contact has no published WhatsApp number.' : ''}</p>
        <fieldset className="ow-angles"><legend>Angle</legend>{outreachAngles.map(angle => <label key={angle} className={compose.angle === angle ? 'on' : ''}>
          <input type="radio" name="ow-angle" checked={compose.angle === angle} onChange={() => setCompose({ ...compose, angle })} />
          <span><strong>{angleDefinitions[angle].label}{angle === recommendation.angle && <span className="ow-recommended">Recommended</span>}</strong><small>{angleDefinitions[angle].help}</small></span></label>)}</fieldset>
        <details className="ow-why-recommended"><summary>Why this recommendation</summary><ul>{recommendation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>
        <label>Extra instructions <span className="br-muted">(optional)</span><textarea rows={2} maxLength={500} value={compose.instructions} placeholder="For example: mention our work with other clinics in Austin" onChange={event => setCompose({ ...compose, instructions: event.target.value })} /></label>
        <p className="br-muted ow-hint">Tone {toneLabels[preferences.tone].toLowerCase()} · {lengthLabels[preferences.length].toLowerCase()} · {objectiveLabels[preferences.objective].toLowerCase()}. Change these in Settings → Outreach.</p>
        <button className="primary ow-generate" disabled={busy || aiOff} onClick={() => void generate()}><Icon name="spark" size={16} />{busy ? 'Working…' : 'Generate draft'}</button>
      </section>

      <section className="ow-editor-wrap" aria-label="Drafts">
        {draft ? <article className="ow-editor">
          <header>
            <div><span className="ow-chip"><Icon name={channelIcons[draft.channel]} size={14} />{channelLabels[draft.channel]}{draft.sequenceStep ? ` · follow-up ${draft.sequenceStep}` : ''}</span>
              <span className={`ow-draft-status ${draft.status}`}>{draftStatusLabels[draft.status]}</span>
              <span className="br-muted">Version {draft.version} · {originLabels[draft.origin]} · {angleDefinitions[draft.angle].label}{draft.contactName ? ` · to ${draft.contactName}` : ''}{draft.model ? ` · ${draft.model}` : ''}</span></div>
          </header>
          <div className={`ow-grounding ${draft.grounding}`}>
            {draft.grounding === 'evidence' ? <><h4>Based on the business report</h4><ul>{draft.claims.map((claim, index) => <li key={index}><span>{claim.statement}</span>
              <small className="br-muted">{claim.findingIds.map(id => findings.get(id)?.title).filter(Boolean).join(' · ') || 'A finding in an earlier report'}{claim.sourceUrls.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow"> {url.replace(/^https?:\/\//, '').slice(0, 40)}</a>)}</small></li>)}</ul></>
              : <p><strong>General introduction.</strong> This message doesn’t rely on a specific finding.</p>}
            {['edited', 'restored'].includes(draft.origin) && draft.grounding === 'evidence' && <p className="br-muted">Edited after generation: check that it still matches the evidence above.</p>}
            {!!draft.warnings.length && <ul className="ow-warnings">{draft.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
          </div>
          {draft.channel === 'email' && <label>Subject<input value={subject} maxLength={200} onChange={event => setSubject(event.target.value)} /></label>}
          <label>Message<textarea className="ow-body" rows={draft.channel === 'email' ? 12 : 6} value={body} maxLength={6000} onChange={event => setBody(event.target.value)} /></label>
          <p className={`ow-counter${body.length > limit ? ' over' : ''}`} aria-live="polite">{body.length} / {limit} characters{draft.channel === 'linkedin_connection' ? ' (LinkedIn’s limit for invitation notes)' : ''}</p>
          <div className="ow-actions ow-editor-actions">
            <button className="primary" disabled={busy || !dirty || body.length > limit || !body.trim()} onClick={() => void save()}>Save changes</button>
            {dirty && <button className="text-button" onClick={() => { setSubject(draft.subject); setBody(draft.body) }}>Discard changes</button>}
            <button className="secondary" disabled={busy} onClick={() => void copy()}><Icon name="copy" size={15} />Copy</button>
            {draft.channel === 'email' && draftContact?.email && <a className="secondary ow-link-button" href={mailtoLink(draftContact.email, subject, body)}><Icon name="mail" size={15} />Open in email app</a>}
            {draft.channel === 'whatsapp' && draftContact?.whatsapp && <a className="secondary ow-link-button" href={whatsappLink(draftContact.whatsapp, body)} target="_blank" rel="noopener noreferrer">Open WhatsApp chat</a>}
            {draft.channel.startsWith('linkedin') && (draftContact?.linkedinUrl || draftContact?.profileUrl) && <a className="secondary ow-link-button" href={draftContact.linkedinUrl || draftContact.profileUrl} target="_blank" rel="noopener noreferrer nofollow">Open LinkedIn profile</a>}
          </div>
          <div className="ow-status-row" role="group" aria-label="Status">
            <span className="br-muted">Status:</span>
            {draft.status !== 'ready' && !['sent', 'replied'].includes(draft.status) && <button className="secondary" disabled={busy || dirty} onClick={() => void status('ready')}>Ready to send</button>}
            {!['sent', 'replied'].includes(draft.status) && <button className="secondary" disabled={busy || dirty} onClick={() => setConfirm({ kind: 'sent', message: 'Mark as sent only after you’ve sent it yourself. LeadFlow doesn’t send messages.' })}>Mark as sent…</button>}
            {['sent', 'follow_up'].includes(draft.status) && <button className="secondary" disabled={busy} onClick={() => void status('replied')}>They replied</button>}
            {draft.status === 'sent' && <button className="secondary" disabled={busy} onClick={() => void status('follow_up')}>Follow-up required</button>}
            {draft.status !== 'archived' ? <button className="text-button" disabled={busy} onClick={() => void status('archived')}>Archive</button> : <button className="text-button" disabled={busy} onClick={() => void status('draft')}>Restore from archive</button>}
            {['ready', 'sent', 'replied', 'follow_up'].includes(draft.status) && <button className="text-button" disabled={busy} onClick={() => void status('draft')}>Back to draft</button>}
          </div>
          {confirm?.kind === 'sent' && <div className="br-confirm" role="alert"><p>{confirm.message}</p><div className="br-actions"><button className="secondary" onClick={() => setConfirm(null)}>Not yet</button><button className="primary" disabled={busy} onClick={() => void status('sent')}>I sent it: mark as sent</button></div></div>}
          {['sent', 'follow_up', 'replied'].includes(draft.status) && <div className="ow-followups">
            {!!reminders.length && <p><span className="br-muted">Reminders (nothing is sent automatically):</span> {reminders.map(date => <button key={date} className="text-button" disabled={busy} onClick={() => void onPlanFollowUp(date, `Follow up on ${channelLabels[draft.channel].toLowerCase()}${draft.contactName ? ` to ${draft.contactName}` : ''}: “${titleOf(draft).slice(0, 80)}”`).then(saved => { if (saved) setNotice(`Reminder added to Follow-ups for ${dateLabel(date)}.`); else setError('The reminder couldn’t be saved. Close this window and choose Retry saving.') })}>Remind me {dateLabel(date)}</button>)}</p>}
            {draft.status !== 'replied' && draft.sequenceStep < 3 && <button className="secondary" disabled={busy} onClick={followUp}>Prepare a follow-up draft</button>}
            <label>Notes on the conversation<textarea rows={2} maxLength={2000} value={notes} placeholder="What they replied, what to mention next…" onChange={event => setNotes(event.target.value)}
              onBlur={() => { if (notes !== draft.notes) void guarded(async () => replace(await saveDraft(workspace.id, draft.id, draft.version, { notes }))) }} /></label>
          </div>}
          <div className="ow-actions ow-secondary-actions">
            {!['sent', 'replied'].includes(draft.status) && <><label className="ow-inline">Angle<select value={regenerateAngle} onChange={event => setRegenerateAngle(event.target.value as OutreachAngle)}>{outreachAngles.map(angle => <option key={angle} value={angle}>{angleDefinitions[angle].label}</option>)}</select></label>
              <button className="secondary" disabled={busy || aiOff || dirty} title={dirty ? 'Save or discard your changes first' : undefined} onClick={() => void generate({ draft, replaceEdited: false })}><Icon name="reset" size={15} />Regenerate</button></>}
            <button className="text-button" disabled={busy} onClick={() => void guarded(async () => { const copied = await duplicateDraft(workspace.id, draft.id, crypto.randomUUID()); replace(copied); setSelected(copied.id); setNotice('Duplicated as a new draft.') })}>Duplicate</button>
            <button className="text-button ow-danger-link" disabled={busy} onClick={() => setConfirm({ kind: 'delete', message: 'Delete this draft and its versions?' })}>Delete</button>
          </div>
          {confirm?.kind === 'regenerate' && <div className="br-confirm" role="alert"><p>{confirm.message}</p><div className="br-actions"><button className="secondary" onClick={() => setConfirm(null)}>Keep my edit</button><button className="primary" disabled={busy} onClick={() => void generate({ draft, replaceEdited: true })}>Regenerate anyway</button></div></div>}
          {confirm?.kind === 'delete' && <div className="br-confirm" role="alert"><p>{confirm.message}</p><div className="br-actions"><button className="secondary" onClick={() => setConfirm(null)}>Keep it</button>
            <button className="danger" disabled={busy} onClick={() => void guarded(async () => { await deleteDraft(workspace.id, draft.id); setDrafts(items => items.filter(item => item.id !== draft.id)); setSelected(null); setConfirm(null); setNotice('Draft deleted.') })}>Delete draft</button></div></div>}
          <Versions key={draftKey} workspaceId={workspace.id} draft={draft} busy={busy} onRestore={version => void guarded(async () => { const next = await restoreVersion(workspace.id, draft.id, version, draft.version); replace(next); setNotice(`Version ${version} restored as version ${next.version}.`) })} />
        </article> : <div className="ow-empty"><span className="ow-empty-icon" aria-hidden="true"><Icon name="mail" size={22} /></span><h4>No draft selected</h4><p>Choose an opportunity, a contact, a channel and an angle, then generate a draft. You review and send every message yourself.</p></div>}

        <div className="ow-draft-list">
          <div className="ow-draft-list-head"><h4>Drafts <span className="number-tag">{drafts.length}</span></h4>
            <select aria-label="Filter drafts" value={filter} onChange={event => setFilter(event.target.value)}>{statusFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          {visible.length ? <ul>{visible.map(item => <li key={item.id}><button className={item.id === selected ? 'on' : ''} aria-current={item.id === selected} onClick={() => { if (!dirty || item.id === selected) setSelected(item.id); else setError('Save or discard your changes before opening another draft.') }}>
            <Icon name={channelIcons[item.channel]} size={15} /><span><strong>{titleOf(item)}</strong><small>{channelLabels[item.channel]}{item.sequenceStep ? ` · follow-up ${item.sequenceStep}` : ''}{item.contactName ? ` · ${item.contactName}` : ''} · {dateLabel(item.updatedAt)}</small></span>
            <span className={`ow-draft-status ${item.status}`}>{draftStatusLabels[item.status]}</span></button></li>)}</ul> : <p className="br-muted">{drafts.length ? 'No drafts match this filter.' : 'No drafts yet.'}</p>}
        </div>
      </section>
    </div>
  </div>
}
