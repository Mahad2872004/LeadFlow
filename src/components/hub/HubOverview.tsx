import { useState } from 'react'
import { dateLabel } from '../../lib/format'
import { projectTypeLabels, type ProjectType } from '../../lib/projects'
import { hubHome, hubProjectStatusLabels, type AwaitingItem, type HubProjectCard } from '../../lib/hub'
import { Icon } from '../Icon'
import { Chip, Empty, ErrorState, FileRow, HubLink, PageHead, Progress, Section, Skeleton } from './hubShared'
import { dueText, firstName, projectTone, timeAgo, useHub, useLoad } from './hubKit'

const categoryLabel = (category: string) => projectTypeLabels[category as ProjectType] ?? 'Project'
const greeting = () => { const hour = new Date().getHours(); return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening' }

export function ProjectCard({ project }: { project: HubProjectCard }) {
  return <HubLink to={`/portal/projects/${project.id}`} className="hb-project-card" ariaLabel={`${project.name}: ${hubProjectStatusLabels[project.status]}, ${project.progress}% complete`}>
    <div className="hb-project-card-top">
      <span className="hb-eyebrow">{categoryLabel(project.category)}</span>
      <Chip tone={projectTone(project.status)}>{hubProjectStatusLabels[project.status]}</Chip>
    </div>
    <h3>{project.name}</h3>
    <Progress value={project.progress} label="Progress" />
    <dl className="hb-facts">
      <div><dt>Started</dt><dd>{project.startDate ? dateLabel(project.startDate) : '—'}</dd></div>
      <div><dt>{project.completedOn ? 'Completed' : 'Expected'}</dt><dd>{project.completedOn ? dateLabel(project.completedOn) : project.targetDate ? dateLabel(project.targetDate) : 'To be confirmed'}</dd></div>
    </dl>
    {project.nextMilestone && <p className="hb-next"><Icon name="calendar" size={15} /><span>Next: <strong>{project.nextMilestone.name}</strong>{project.nextMilestone.dueDate ? ` · ${dateLabel(project.nextMilestone.dueDate)}` : ''}</span></p>}
    {project.awaitingReview > 0 && <p className="hb-action-flag"><Icon name="check" size={15} /> {project.awaitingReview} awaiting your review</p>}
  </HubLink>
}

function AwaitingCard({ item }: { item: AwaitingItem }) {
  const overdue = !!item.dueDate && dueText(item.dueDate).includes('overdue')
  return <li className="hb-await">
    <span className="hb-await-icon" aria-hidden="true"><Icon name={item.canDecide ? 'check' : 'chat'} size={18} /></span>
    <div className="hb-await-main">
      <strong>{item.title}</strong>
      <small>{item.projectName} · Version {item.versionNumber} · requested {timeAgo(item.requestedAt)}</small>
    </div>
    <span className={`hb-due${overdue ? ' is-late' : ''}`}>{dueText(item.dueDate)}</span>
    <HubLink to={`/portal/projects/${item.projectId}/deliverables/${item.deliverableId}`} className={`hb-btn is-sm ${item.canDecide ? 'is-primary' : 'is-secondary'}`} ariaLabel={`${item.canDecide ? 'Review' : 'Give feedback on'} ${item.title}`}>
      {item.canDecide ? 'Review' : 'Give feedback'}
    </HubLink>
  </li>
}

export function OverviewPage() {
  const hub = useHub()
  const { data, error, loading, reload } = useLoad(`home:${hub.accessId}`, () => hubHome(hub.accessId))
  if (loading) return <div className="hb-page"><Skeleton rows={2} /><div className="hb-grid"><Skeleton rows={4} /><Skeleton rows={4} /></div></div>
  if (error || !data) return <div className="hb-page"><ErrorState message={error ?? ''} onRetry={reload} /></div>
  const active = data.projects.filter(project => project.status !== 'completed' && project.status !== 'cancelled')
  return <div className="hb-page">
    <section className="hb-hero">
      <div>
        <p className="hb-eyebrow">{data.client.name} · with {data.agencyName}</p>
        <h1>{greeting()}, {firstName(data.access.name, data.access.email)}</h1>
        <p className="hb-lede">{data.awaiting.length ? `${data.awaiting.length} item${data.awaiting.length === 1 ? ' is' : 's are'} waiting for you.` : 'You’re all caught up. Here’s where your projects stand.'}</p>
      </div>
      <dl className="hb-hero-stats">
        <div><dt>Active projects</dt><dd>{active.length}</dd></div>
        <div><dt>Awaiting you</dt><dd>{data.awaiting.length}</dd></div>
        <div><dt>Unread</dt><dd>{data.unread}</dd></div>
      </dl>
    </section>
    <Section title="Waiting for you" action={data.awaiting.length > 0 ? <HubLink to="/portal/reviews" className="hb-text-link">All reviews</HubLink> : undefined}>
      {data.awaiting.length ? <ul className="hb-await-list">{data.awaiting.map(item => <AwaitingCard key={item.reviewId} item={item} />)}</ul>
        : <Empty icon="check" title="Nothing to review right now">When your agency shares work for your review, it appears here.</Empty>}
    </Section>
    <Section title="Your projects" action={data.projects.length > 0 ? <HubLink to="/portal/projects" className="hb-text-link">All projects</HubLink> : undefined}>
      {data.projects.length ? <div className="hb-project-grid">{(active.length ? active : data.projects).slice(0, 6).map(project => <ProjectCard key={project.id} project={project} />)}</div>
        : <Empty icon="project" title="No projects shared yet">Your agency hasn’t shared a project with you yet. You’ll get a notification when they do.</Empty>}
    </Section>
    <div className="hb-grid">
      <Section title="Coming up">
        {data.upcoming.length ? <ul className="hb-timeline-mini">{data.upcoming.map(item => <li key={`${item.kind}-${item.id}`}>
          <time dateTime={item.dueDate}><b>{new Date(`${item.dueDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric' })}</b>{new Date(`${item.dueDate}T12:00:00`).toLocaleDateString(undefined, { month: 'short' })}</time>
          <div><strong>{item.title}</strong><small>{item.kind === 'milestone' ? 'Milestone' : 'Deliverable'} · {item.projectName}</small></div>
        </li>)}</ul> : <Empty icon="calendar" title="No upcoming dates">Milestones and deliverables with dates appear here.</Empty>}
      </Section>
      <Section title="Latest updates">
        {data.updates.length ? <ul className="hb-update-mini">{data.updates.map(update => <li key={update.id}>
          <HubLink to={`/portal/projects/${update.projectId}/updates`}><strong>{update.title}</strong></HubLink>
          <small>{update.projectName} · {update.publishedAt ? timeAgo(update.publishedAt) : ''}</small>
          {update.body && <p>{update.body.length > 180 ? `${update.body.slice(0, 180)}…` : update.body}</p>}
        </li>)}</ul> : <Empty icon="spark" title="No updates yet">Your agency’s project updates appear here.</Empty>}
      </Section>
    </div>
    <div className="hb-grid">
      <Section title="Recent messages" action={<HubLink to="/portal/messages" className="hb-text-link">Messages</HubLink>}>
        {data.messages.length ? <ul className="hb-message-mini">{data.messages.map(message => <li key={message.id}>
          <HubLink to={message.deliverableId ? `/portal/projects/${message.projectId}/deliverables/${message.deliverableId}` : `/portal/projects/${message.projectId}/messages`}>
            <strong>{message.author}</strong><small>{message.projectName} · {timeAgo(message.createdAt)}</small>
            <p>{message.body.length > 140 ? `${message.body.slice(0, 140)}…` : message.body}</p>
          </HubLink>
        </li>)}</ul> : <Empty icon="chat" title="No messages yet">Conversations with your agency appear here.</Empty>}
      </Section>
      <Section title="Shared files" action={<HubLink to="/portal/files" className="hb-text-link">All files</HubLink>}>
        {data.files.length ? <ul className="hb-files">{data.files.map(file => <FileRow key={file.id} file={file} />)}</ul>
          : <Empty icon="clipboard" title="No shared files yet">Files your agency shares appear here.</Empty>}
      </Section>
    </div>
  </div>
}

export function ProjectsPage() {
  const hub = useHub()
  const { data, error, loading, reload } = useLoad(`home:${hub.accessId}`, () => hubHome(hub.accessId))
  const [filter, setFilter] = useState<'active' | 'done' | 'all'>('active')
  if (loading) return <div className="hb-page"><Skeleton rows={4} /></div>
  if (error || !data) return <div className="hb-page"><ErrorState message={error ?? ''} onRetry={reload} /></div>
  const done = (project: HubProjectCard) => project.status === 'completed' || project.status === 'cancelled'
  const shown = data.projects.filter(project => filter === 'all' || (filter === 'done') === done(project))
  return <div className="hb-page">
    <PageHead eyebrow={data.client.name} title="My projects" description="Everything your agency is working on with you." />
    <div className="hb-segment" role="group" aria-label="Show projects">
      {([['active', 'Active'], ['done', 'Completed'], ['all', 'All']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}
        <b>{key === 'all' ? data.projects.length : data.projects.filter(project => (key === 'done') === done(project)).length}</b></button>)}
    </div>
    {shown.length ? <div className="hb-project-grid">{shown.map(project => <ProjectCard key={project.id} project={project} />)}</div>
      : <Empty icon="project" title={filter === 'done' ? 'No completed projects yet' : 'No projects here'}>{data.projects.length ? 'Try another filter.' : 'Your agency hasn’t shared a project with you yet.'}</Empty>}
  </div>
}

export function ReviewsPage() {
  const hub = useHub()
  const { data, error, loading, reload } = useLoad(`home:${hub.accessId}`, () => hubHome(hub.accessId))
  if (loading) return <div className="hb-page"><Skeleton rows={4} /></div>
  if (error || !data) return <div className="hb-page"><ErrorState message={error ?? ''} onRetry={reload} /></div>
  const decide = data.awaiting.filter(item => item.canDecide), feedback = data.awaiting.filter(item => !item.canDecide)
  return <div className="hb-page">
    <PageHead eyebrow={data.client.name} title="Reviews & approvals" description={hub.role === 'member'
      ? 'Your role can give feedback and comment. Approvals are made by your organization’s reviewers and admins.'
      : 'Work your agency has asked you to review. Approve it, request changes, or reject it with a reason.'} />
    {data.awaiting.length === 0 ? <Empty icon="check" title="Nothing to review right now">When your agency shares work for your review, it appears here and you’ll get a notification.</Empty> : <>
      {decide.length > 0 && <Section title="Waiting for your decision"><ul className="hb-await-list">{decide.map(item => <AwaitingCard key={item.reviewId} item={item} />)}</ul></Section>}
      {feedback.length > 0 && <Section title={decide.length ? 'Open for feedback' : 'Open reviews'}>
        <p className="hb-muted hb-section-note">You can add feedback and comments on these; {hub.role === 'member' ? 'approvals are made by your organization’s reviewers and admins' : 'they were assigned to someone else for a decision'}.</p>
        <ul className="hb-await-list">{feedback.map(item => <AwaitingCard key={item.reviewId} item={item} />)}</ul></Section>}
    </>}
  </div>
}

export function MessagesPage() {
  const hub = useHub()
  const { data, error, loading, reload } = useLoad(`home:${hub.accessId}`, () => hubHome(hub.accessId))
  if (loading) return <div className="hb-page"><Skeleton rows={4} /></div>
  if (error || !data) return <div className="hb-page"><ErrorState message={error ?? ''} onRetry={reload} /></div>
  return <div className="hb-page">
    <PageHead eyebrow={data.client.name} title="Messages" description="Conversations with your agency happen on each project and deliverable." />
    <Section title="Project conversations">
      {data.projects.length ? <ul className="hb-conversations">{data.projects.map(project => <li key={project.id}>
        <HubLink to={`/portal/projects/${project.id}/messages`} className="hb-conversation">
          <span className="hb-conversation-icon" aria-hidden="true"><Icon name="chat" size={18} /></span>
          <span><strong>{project.name}</strong><small>{hubProjectStatusLabels[project.status]}{project.awaitingReview ? ` · ${project.awaitingReview} awaiting review` : ''}</small></span>
          <Icon name="chevron" size={16} />
        </HubLink>
      </li>)}</ul> : <Empty icon="chat" title="No conversations yet">Once your agency shares a project, you can message them about it here.</Empty>}
    </Section>
    <Section title="Latest messages">
      {data.messages.length ? <ul className="hb-message-mini">{data.messages.map(message => <li key={message.id}>
        <HubLink to={message.deliverableId ? `/portal/projects/${message.projectId}/deliverables/${message.deliverableId}` : `/portal/projects/${message.projectId}/messages`}>
          <strong>{message.author}{message.authorType === 'member' ? ' · Agency' : ''}</strong><small>{message.projectName} · {timeAgo(message.createdAt)}</small>
          <p>{message.body}</p>
        </HubLink>
      </li>)}</ul> : <Empty icon="chat" title="No messages yet" />}
    </Section>
  </div>
}
