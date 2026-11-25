import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { HealthBadge, PriorityChip, ProgressBar, ProjectStatusChip } from './ProjectBits'
import { NewProjectDialog } from './NewProjectDialog'
import type { WorkspaceSummary } from '../lib/backend'
import type { ClientDetail, ClientIndexEntry } from '../lib/clients'
import { errorText, shortDate, type SalesMember } from '../lib/sales'
import { listProjects, projectTypeLabels, type ProjectPage } from '../lib/projects'

/**
 * A client's projects (the client workspace's Projects tab). New projects start from the completed onboarding when there
 * is one, otherwise from the client's confirmed scope; the dialog shows which before anything is created.
 */
export function ClientProjects({ workspace, client, members, clients, version, onOpenProject, onCreated }: {
  workspace: WorkspaceSummary; client: ClientDetail; members: SalesMember[]; clients: ClientIndexEntry[]; version: number
  onOpenProject: (id: string) => void; onCreated: (result: { id: string; workspaceChanged: boolean }, name: string) => void
}) {
  const [page, setPage] = useState<ProjectPage | null>(null), [error, setError] = useState(''), [creating, setCreating] = useState(false), [created, setCreated] = useState(0)
  useEffect(() => {
    let active = true
    listProjects(workspace.id, { clientId: client.id, status: 'all', sort: 'created', direction: 'desc', limit: 100 }).then(value => { if (active) { setPage(value); setError('') } })
      .catch(cause => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [workspace.id, client.id, version, created])
  const archived = client.status === 'archived'
  return <section className="panel cl-section pf-client">
    <div className="section-heading"><div><h2>Projects {page && <span className="number-tag">{page.total}</span>}</h2>
      <p>{client.completion ? `Onboarding was completed on ${shortDate(client.completion.completedAt)}. New projects start from what was agreed then.` : 'Onboarding isn’t completed yet. A new project starts from the client’s currently confirmed services and requirements.'}</p></div>
      {!archived && <button className="primary" onClick={() => setCreating(true)}><Icon name="plus" size={17} /> New project</button>}</div>
    {archived && <p className="sp-caution pf-inset">This client is archived, so its projects are read-only.</p>}
    {error && <p className="sp-error sp-inset" role="alert">{error}</p>}
    {!page ? <p className="sp-loading" role="status">Loading projects…</p>
      : !page.items.length ? <div className="empty"><h3>No projects yet</h3><p>{client.completion ? 'Turn the agreed scope into a project with milestones, deliverables and tasks.' : 'You can start a project now, or complete onboarding first so the project starts from the agreed scope.'}</p>
        {!archived && <button className="secondary" onClick={() => setCreating(true)}>New project</button>}</div>
      : <ul className="pf-client-list">{page.items.map(project => <li key={project.id}>
        <button className="pf-client-project" onClick={() => onOpenProject(project.id)} aria-label={`Open ${project.name}`}>
          <span className="pf-client-head"><strong>{project.name}</strong><ProjectStatusChip status={project.status} /><PriorityChip priority={project.priority} /></span>
          <span className="sp-muted">{projectTypeLabels[project.projectType]}{project.targetDate ? ` · target ${shortDate(project.targetDate)}` : ''}{project.ownerName ? ` · ${project.ownerName}` : ''}{project.overdue ? ' · overdue' : ''}</span>
          <span className="pf-client-meta"><ProgressBar progress={project.progress} /><HealthBadge health={project.health} /></span>
        </button></li>)}</ul>}
    {creating && <NewProjectDialog workspace={workspace} members={members} clients={clients.some(item => item.id === client.id) ? clients : [...clients, { id: client.id, name: client.name, status: client.status, leadId: client.leadId, dealId: client.dealId }]}
      start={{ clientId: client.id }} onClose={() => setCreating(false)} onCreated={(result, name) => { setCreating(false); setCreated(value => value + 1); onCreated(result, name) }} />}
  </section>
}
