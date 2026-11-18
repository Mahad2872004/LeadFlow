import { useEffect, useState } from 'react'
import { lengthLabels, objectiveLabels, outreachConfig, outreachLengths, outreachObjectives, outreachPreferences, outreachTones, outreachUsage, saveOutreachPreferences, toneLabels,
  type OutreachConfig, type OutreachUsage, type PreferenceSettings, type Preferences } from '../lib/outreach'
import { apolloLeft, apolloStatus, accountLabel, remainingOf, type ApolloStatus } from '../lib/apollo'
import type { WorkspaceSummary } from '../lib/backend'
import { dateLabel } from '../lib/format'
import './Outreach.css'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Try again.'
const unitLabels: Record<string, string> = { pages: 'pages read', lookups: 'mail-server lookups', input_tokens: 'AI input tokens', output_tokens: 'AI output tokens', requests: 'AI requests' }
const providerLabels: Record<string, string> = { website: 'Website reader', dns: 'DNS (mail servers)', gemini: 'Gemini' }
type WorkspaceForm = Omit<Preferences, 'caseStudyLinks' | 'followupIntervals'> & { caseStudyLinks: string; followupIntervals: string }

/** Outreach settings: the agency's identity and writing defaults (owners and admins), each member's sender details, and usage. */
export function OutreachSettings({ workspace }: { workspace: WorkspaceSummary }) {
  const [settings, setSettings] = useState<PreferenceSettings | null>(null), [usage, setUsage] = useState<OutreachUsage | null>(null)
  const [config, setConfig] = useState<OutreachConfig | null>(null), [apollo, setApollo] = useState<ApolloStatus | null>(null)
  const [form, setForm] = useState<WorkspaceForm | null>(null), [mine, setMine] = useState({ senderName: '', senderRole: '', contactDetails: '', tone: '', length: '' })
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  function fill(value: PreferenceSettings) {
    setSettings(value)
    const e = value.effective, w = value.workspace ?? {}
    setForm({ ...e, agencyName: w.agencyName ?? '', senderName: w.senderName ?? '', senderRole: w.senderRole ?? '', contactDetails: w.contactDetails ?? '', tone: w.tone ?? e.tone, length: w.length ?? e.length,
      caseStudyLinks: e.caseStudyLinks.join('\n'), followupIntervals: e.followupIntervals.join(', ') })
    setMine({ senderName: value.mine?.senderName ?? '', senderRole: value.mine?.senderRole ?? '', contactDetails: value.mine?.contactDetails ?? '', tone: value.mine?.tone ?? '', length: value.mine?.length ?? '' })
  }
  useEffect(() => {
    let active = true
    outreachPreferences(workspace.id).then(value => { if (active) fill(value) }).catch(cause => { if (active) setError(errorText(cause)) })
    outreachUsage(workspace.id).then(value => { if (active) setUsage(value) }).catch(() => { /* Informational. */ })
    outreachConfig(workspace.id).then(value => { if (active) { setConfig(value); if (value.providers.apollo.enabled) apolloStatus(workspace.id).then(status => { if (active) setApollo(status) }).catch(() => null) } }).catch(() => null)
    return () => { active = false }
  }, [workspace.id])
  async function save(scope: 'workspace' | 'user', event: React.FormEvent) {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      // An empty personal tone or length means "use the workspace default".
      const values: Record<string, unknown> = scope === 'user' ? { senderName: mine.senderName.trim(), senderRole: mine.senderRole.trim(), contactDetails: mine.contactDetails.trim(), tone: mine.tone, length: mine.length }
        : { agencyName: form!.agencyName.trim(), agencyDescription: form!.agencyDescription.trim(), agencyWebsite: form!.agencyWebsite.trim(), senderName: form!.senderName.trim(), senderRole: form!.senderRole.trim(),
          contactDetails: form!.contactDetails.trim(), tone: form!.tone, length: form!.length, objective: form!.objective, preferredCta: form!.preferredCta.trim(), avoidPhrases: form!.avoidPhrases.trim(),
          customInstructions: form!.customInstructions.trim(), caseStudyLinks: form!.caseStudyLinks.split(/\s+/).map(link => link.trim()).filter(Boolean),
          followupIntervals: form!.followupIntervals.split(/[\s,]+/).filter(Boolean).map(Number) }
      fill(await saveOutreachPreferences(workspace.id, scope, values as Partial<Preferences>)); setNotice(scope === 'user' ? 'Your sender details were saved.' : 'Outreach settings saved.')
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  if (!settings || !form) return <section className="panel ow-settings" aria-label="Outreach settings">{error ? <p className="br-error" role="alert">{error}</p> : <i className="skeleton skeleton-panel" />}</section>
  const readOnly = !settings.canEditWorkspace
  const text = (key: keyof WorkspaceForm, label: string, options: { max: number; area?: boolean; placeholder?: string; type?: string } ) => <label className={options.area ? 'ow-wide' : ''}>{label}
    {options.area ? <textarea rows={2} maxLength={options.max} value={form[key] as string} disabled={readOnly} placeholder={options.placeholder} onChange={event => setForm({ ...form, [key]: event.target.value })} />
      : <input type={options.type ?? 'text'} maxLength={options.max} value={form[key] as string} disabled={readOnly} placeholder={options.placeholder} onChange={event => setForm({ ...form, [key]: event.target.value })} />}</label>
  return <section className="panel ow-settings" aria-labelledby="ow-settings-title">
    <div className="section-heading"><div><h2 id="ow-settings-title">Outreach</h2><p>How drafts introduce your agency. AI drafts follow these settings, never above the rule that every claim must be backed by evidence.</p></div></div>
    {notice && <p className="br-notice" role="status">{notice}</p>}
    {error && <p className="br-error" role="alert">{error}</p>}
    <form className="ow-form" onSubmit={event => void save('workspace', event)} aria-label="Workspace outreach settings">
      <h4>Agency identity and writing defaults {readOnly && <span className="br-muted">(owners and admins can change these)</span>}</h4>
      <div className="ow-form-grid">
        {text('agencyName', 'Agency name', { max: 100, placeholder: workspace.name })}
        {text('agencyWebsite', 'Agency website', { max: 300, placeholder: 'https://', type: 'url' })}
        {text('agencyDescription', 'Short description', { max: 600, area: true, placeholder: 'What you do and for whom, in one or two sentences.' })}
        {text('senderName', 'Default sender name', { max: 100 })}
        {text('senderRole', 'Default sender role', { max: 100 })}
        {text('contactDetails', 'Contact details for signatures', { max: 300, placeholder: 'Phone, booking link…' })}
        <label>Tone<select value={form.tone} disabled={readOnly} onChange={event => setForm({ ...form, tone: event.target.value as Preferences['tone'] })}>{outreachTones.map(tone => <option key={tone} value={tone}>{toneLabels[tone]}</option>)}</select></label>
        <label>Length<select value={form.length} disabled={readOnly} onChange={event => setForm({ ...form, length: event.target.value as Preferences['length'] })}>{outreachLengths.map(length => <option key={length} value={length}>{lengthLabels[length]}</option>)}</select></label>
        <label>Objective<select value={form.objective} disabled={readOnly} onChange={event => setForm({ ...form, objective: event.target.value as Preferences['objective'] })}>{outreachObjectives.map(objective => <option key={objective} value={objective}>{objectiveLabels[objective]}</option>)}</select></label>
        {text('preferredCta', 'Preferred call to action', { max: 200, placeholder: 'Would a 15-minute call next week work?' })}
        {text('avoidPhrases', 'Words and phrases to avoid', { max: 500 })}
        {text('customInstructions', 'Other instructions (style only)', { max: 1500, area: true, placeholder: 'Industry context, preferred introduction…' })}
        {text('caseStudyLinks', 'Case-study links (one per line, up to 5)', { max: 1600, area: true, placeholder: 'https://…' })}
        {text('followupIntervals', 'Suggested follow-up reminders (days after sending)', { max: 20, placeholder: '3, 7, 14' })}
      </div>
      {!readOnly && <div className="modal-actions"><button className="primary" disabled={busy}>Save outreach settings</button></div>}
    </form>
    <form className="ow-form" onSubmit={event => void save('user', event)} aria-label="Your sender details">
      <h4>Your sender details</h4>
      <p className="br-muted">Used for drafts you generate. Empty fields use the workspace defaults.</p>
      <div className="ow-form-grid">
        <label>Your name<input maxLength={100} value={mine.senderName} placeholder={settings.workspace?.senderName ?? ''} onChange={event => setMine({ ...mine, senderName: event.target.value })} /></label>
        <label>Your role<input maxLength={100} value={mine.senderRole} placeholder={settings.workspace?.senderRole ?? ''} onChange={event => setMine({ ...mine, senderRole: event.target.value })} /></label>
        <label>Your contact details<input maxLength={300} value={mine.contactDetails} onChange={event => setMine({ ...mine, contactDetails: event.target.value })} /></label>
        <label>Your tone<select value={mine.tone} onChange={event => setMine({ ...mine, tone: event.target.value })}><option value="">Workspace default</option>{outreachTones.map(tone => <option key={tone} value={tone}>{toneLabels[tone]}</option>)}</select></label>
        <label>Your length<select value={mine.length} onChange={event => setMine({ ...mine, length: event.target.value })}><option value="">Workspace default</option>{outreachLengths.map(length => <option key={length} value={length}>{lengthLabels[length]}</option>)}</select></label>
      </div>
      <div className="modal-actions"><button className="primary" disabled={busy}>Save my details</button></div>
    </form>
    <div className="ow-usage" aria-label="Contacts and outreach usage">
      <h4>Usage this month</h4>
      <ul className="ow-usage-stats">
        <li><strong>{usage?.contactSearches ?? '—'}</strong><span>contact searches{config ? ` of ${config.limits.monthlySearches}` : ''}</span></li>
        <li><strong>{usage?.generations ?? '—'}</strong><span>AI drafts{config ? ` of ${config.limits.monthlyGenerations}` : ''}</span></li>
        <li><strong>{config ? (config.providers.ai.configured ? 'On' : 'Off') : '—'}</strong><span>AI drafting{config?.providers.ai.model ? ` · ${config.providers.ai.model}` : config && !config.providers.ai.configured ? ' · add GEMINI_API_KEY' : ''}</span></li>
      </ul>
      {usage && usage.usage.length ? <table className="br-table"><thead><tr><th>Provider</th><th>Used</th><th>Credits</th><th>Failed calls</th></tr></thead><tbody>
        {usage.usage.map(item => <tr key={`${item.provider}-${item.operation}-${item.unit}`}><td>{providerLabels[item.provider] ?? item.provider}</td><td>{Number(item.quantity).toLocaleString()} {unitLabels[item.unit] ?? item.unit.replace(/_/g, ' ')}</td>
          <td>{item.credits === null ? 'Not reported' : Number(item.credits).toLocaleString()}</td><td>{item.failed}</td></tr>)}</tbody></table> : <p className="br-muted">Nothing used yet this month.</p>}
      {apollo && <div className="ow-apollo-usage"><h4>Apollo</h4>{apollo.accounts.filter(account => account.configured).map(account => <p key={account.id}><strong>{accountLabel(account)}</strong>: {remainingOf(account)} of {account.monthlyAllowance} credits left in LeadFlow’s ledger
        {apolloLeft(account, 'lead_credit') !== null ? ` · Apollo reports ${apolloLeft(account, 'lead_credit')} email credits left` : ' · Apollo’s own balance not synced'}{account.lastSyncedAt ? ` (synced ${dateLabel(account.lastSyncedAt)})` : ''}{account.lastConnectionError ? ` · last error: ${account.lastConnectionError}` : ''}</p>)}
        <p className="br-muted">Reveals from the Contacts tab use the same credit ledger as Discovery → Apollo.</p></div>}
      {usage && usage.recent.some(item => item.status !== 'ok') && <details><summary>Recent problems</summary><ul className="ow-plain">{usage.recent.filter(item => item.status !== 'ok').map((item, index) => <li key={index}>{dateLabel(item.at)} · {providerLabels[item.provider] ?? item.provider}: {item.detail ?? item.status}</li>)}</ul></details>}
    </div>
  </section>
}
