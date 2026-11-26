import { useEffect } from 'react'
import { dateLabel } from '../../lib/format'
import { projectTypeLabels, type ProjectType } from '../../lib/projects'
import { hubMilestoneStatusLabels, hubProject, hubProjectStatusLabels, hubReviewLabels, type HubProject } from '../../lib/hub'
import { Icon } from '../Icon'
import { CommentThread } from './HubComments'
import { ProjectFiles } from './HubFiles'
import { Chip, Empty, ErrorState, FileRow, HubLink, PageHead, Progress, Section, Skeleton } from './hubShared'
import { dueText, projectTabs, projectTone, reviewTone, timeAgo, useHub, useLoad, type ProjectTab } from './hubKit'

const tabLabels: Record<ProjectTab, string> = { overview: 'Overview', timeline: 'Timeline & milestones', deliverables: 'Deliverables', messages: 'Discussion', files: 'Files', updates: 'Updates' }

function OverviewTab({ project }: { project: HubProject }) {
  const awaiting = project.deliverables.filter(item => item.openReview)
  return <div className="hb-project-overview">
    <div className="hb-stack">
      {awaiting.length > 0 && <div className="hb-callout is-info">
        <Icon name="check" size={18} />
        <div><strong>{awaiting.length === 1 ? '1 deliverable is' : `${awaiting.length} deliverables are`} waiting for your review</strong>
          <ul>{awaiting.map(item => <li key={item.id}><HubLink to={`/portal/projects/${project.id}/deliverables/${item.id}`}>{item.title}</HubLink> · version {item.openReview!.versionNumber} · {dueText(item.openReview!.dueDate)}</li>)}</ul></div>
      </div>}
      <Section title="About this project">
        {project.summary ? <p className="hb-prose">{project.summary}</p> : <p className="hb-muted">Your agency hasn’t added a summary yet.</p>}
        {project.objectives.length > 0 && <><h3 className="hb-subhead">Objectives</h3><ul className="hb-checks">{project.objectives.map((objective, index) => <li key={index}><Icon name="check" size={16} />{objective}</li>)}</ul></>}
        {project.services.length > 0 && <><h3 className="hb-subhead">Agreed services</h3><ul className="hb-pills">{project.services.map(service => <li key={service}>{service}</li>)}</ul></>}
      </Section>
      {project.updates.length > 0 && <Section title="Latest update" action={<HubLink to={`/portal/projects/${project.id}/updates`} className="hb-text-link">All updates</HubLink>}>
        <UpdateItem update={project.updates[0]} />
      </Section>}
    </div>
    <aside className="hb-stack">
      <div className="hb-card">
        <Progress value={project.progress} label="Overall progress" />
        <dl className="hb-facts is-stacked">
          <div><dt>Status</dt><dd><Chip tone={projectTone(project.status)}>{hubProjectStatusLabels[project.status]}</Chip></dd></div>
          <div><dt>Started</dt><dd>{project.startDate ? dateLabel(project.startDate) : '—'}</dd></div>
          <div><dt>{project.completedOn ? 'Completed' : 'Target completion'}</dt><dd>{project.completedOn ? dateLabel(project.completedOn) : project.targetDate ? dateLabel(project.targetDate) : 'To be confirmed'}</dd></div>
          {project.nextMilestone && <div><dt>Next milestone</dt><dd>{project.nextMilestone.name}{project.nextMilestone.dueDate ? <small>{dateLabel(project.nextMilestone.dueDate)}</small> : null}</dd></div>}
        </dl>
      </div>
      {project.contact && <div className="hb-card hb-contact">
        <p className="hb-eyebrow">Your contact</p>
        <strong>{project.contact.name || project.agencyName}</strong>
        {project.contact.email && <a href={`mailto:${project.contact.email}`} className="hb-text-link"><Icon name="mail" size={14} /> {project.contact.email}</a>}
      </div>}
    </aside>
  </div>
}

function TimelineTab({ project }: { project: HubProject }) {
  if (!project.milestones.length) return <Empty icon="calendar" title="No milestones shared yet">Your agency shares milestones here as the plan takes shape.</Empty>
  const done = project.milestones.filter(milestone => milestone.status === 'completed').length
  return <div className="hb-stack">
    <div className="hb-card hb-timeline-summary">
      <Progress value={project.progress} label="Overall progress" />
      <p className="hb-muted">{done} of {project.milestones.length} milestone{project.milestones.length === 1 ? '' : 's'} completed{project.targetDate ? ` · target ${dateLabel(project.targetDate)}` : ''}</p>
    </div>
    <ol className="hb-milestones">{project.milestones.map(milestone => {
      const deliverables = project.deliverables.filter(item => item.milestoneId === milestone.id)
      return <li key={milestone.id} className={`is-${milestone.status}`}>
        <span className="hb-milestone-dot" aria-hidden="true">{milestone.status === 'completed' ? <Icon name="check" size={14} /> : null}</span>
        <div className="hb-milestone-body">
          <div className="hb-milestone-head"><h3>{milestone.name}</h3><Chip tone={milestone.status === 'completed' ? 'success' : milestone.status === 'in_progress' ? 'info' : 'neutral'}>{hubMilestoneStatusLabels[milestone.status]}</Chip></div>
          <p className="hb-milestone-dates">{milestone.completedAt ? `Completed ${dateLabel(milestone.completedAt)}` : [milestone.startDate && `From ${dateLabel(milestone.startDate)}`, milestone.dueDate && `due ${dateLabel(milestone.dueDate)}`].filter(Boolean).join(' · ') || 'Dates to be confirmed'}</p>
          {milestone.description && <p className="hb-prose">{milestone.description}</p>}
          {deliverables.length > 0 && <ul className="hb-pills">{deliverables.map(item => <li key={item.id}><HubLink to={`/portal/projects/${project.id}/deliverables/${item.id}`}>{item.title}</HubLink></li>)}</ul>}
        </div>
      </li>
    })}</ol>
  </div>
}

function DeliverablesTab({ project }: { project: HubProject }) {
  if (!project.deliverables.length) return <Empty icon="clipboard" title="No deliverables shared yet">When your agency shares work, it appears here for you to view and review.</Empty>
  return <ul className="hb-deliverables">{project.deliverables.map(item => <li key={item.id}>
    <HubLink to={`/portal/projects/${project.id}/deliverables/${item.id}`} className="hb-deliverable-card">
      <div className="hb-deliverable-top"><strong>{item.title}</strong><Chip tone={reviewTone(item.reviewStatus)}>{hubReviewLabels[item.reviewStatus]}</Chip></div>
      {item.description && <p>{item.description.length > 160 ? `${item.description.slice(0, 160)}…` : item.description}</p>}
      <small>{item.latestVersion ? `Version ${item.latestVersion}` : 'No files shared yet'}{item.dueDate ? ` · due ${dateLabel(item.dueDate)}` : ''}{item.completed ? ' · Delivered' : ''}</small>
      {item.openReview && <span className="hb-action-flag"><Icon name="check" size={14} /> Review requested · {dueText(item.openReview.dueDate)}</span>}
    </HubLink>
  </li>)}</ul>
}

function UpdateItem({ update }: { update: HubProject['updates'][number] }) {
  return <article className="hb-update">
    <header><h3>{update.title}</h3><small>{update.author} · {update.publishedAt ? dateLabel(update.publishedAt) : ''}{update.correctedAt ? ' · Corrected' : ''}</small></header>
    {update.body && <p className="hb-prose">{update.body}</p>}
    {update.files.length > 0 && <ul className="hb-files is-compact">{update.files.map(file => <FileRow key={file.id} file={file} />)}</ul>}
  </article>
}

function UpdatesTab({ project }: { project: HubProject }) {
  if (!project.updates.length) return <Empty icon="spark" title="No updates yet">Your agency posts progress updates here.</Empty>
  return <div className="hb-updates">{project.updates.map(update => <UpdateItem key={update.id} update={update} />)}</div>
}

export function ProjectPage({ projectId, tab }: { projectId: string; tab: ProjectTab }) {
  const hub = useHub()
  const { data, error, loading, reload } = useLoad(`project:${projectId}`, () => hubProject(projectId))
  // A link can open a project of another client space this person has; switch to it.
  useEffect(() => { if (data && data.accessId !== hub.accessId) hub.setAccess(data.accessId) }, [data, hub])
  if (loading) return <div className="hb-page"><Skeleton rows={3} /><Skeleton rows={5} /></div>
  if (error || !data) return <div className="hb-page"><PageHead back={{ to: '/portal/projects', label: 'My projects' }} title="Project unavailable" />
    <ErrorState message={error === 'Not found.' ? 'This project isn’t shared with you, or your access changed.' : error ?? ''} onRetry={error === 'Not found.' ? undefined : reload} /></div>
  const counts: Partial<Record<ProjectTab, number>> = { deliverables: data.deliverables.length, updates: data.updates.length, timeline: data.milestones.length }
  return <div className="hb-page">
    <PageHead back={{ to: '/portal/projects', label: 'My projects' }} eyebrow={<>{projectTypeLabels[data.category as ProjectType] ?? 'Project'} · {data.agencyName}</>} title={data.name}
      actions={<Chip tone={projectTone(data.status)}>{hubProjectStatusLabels[data.status]}</Chip>}
      description={<span className="hb-head-progress"><span className="hb-mini-track" aria-hidden="true"><i style={{ width: `${data.progress}%` }} /></span>{data.progress}% complete{data.targetDate && !data.completedOn ? ` · target ${dateLabel(data.targetDate)}` : ''}</span>} />
    <nav className="hb-tabs" aria-label="Project sections">
      {projectTabs.map(key => <HubLink key={key} to={key === 'overview' ? `/portal/projects/${projectId}` : `/portal/projects/${projectId}/${key}`} className={`hb-tab${tab === key ? ' is-active' : ''}`} ariaCurrent={tab === key ? 'page' : undefined}>
        {tabLabels[key]}{counts[key] ? <b>{counts[key]}</b> : null}
      </HubLink>)}
    </nav>
    <div className="hb-tab-body">
      {tab === 'overview' && <OverviewTab project={data} />}
      {tab === 'timeline' && <TimelineTab project={data} />}
      {tab === 'deliverables' && <DeliverablesTab project={data} />}
      {tab === 'messages' && <Section title="Project discussion"><p className="hb-muted hb-section-note">Messages here are visible to your agency’s team and to your colleagues who can open this project.</p>
        <CommentThread projectId={projectId} /></Section>}
      {tab === 'files' && <ProjectFiles projectId={projectId} canUpload={data.canUpload} />}
      {tab === 'updates' && <UpdatesTab project={data} />}
    </div>
    {data.sharedAt && <p className="hb-foot-note">Shared with you {timeAgo(data.sharedAt)} by {data.agencyName}.</p>}
  </div>
}
