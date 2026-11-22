import type { IconName } from '../components/Icon'

export type Page = 'Overview' | 'Leads' | 'Discovery' | 'Follow-ups' | 'Onboarding' | 'Activity' | 'Sales pipeline' | 'Sales analytics' | 'Integrations' | 'Settings'

/** Sidebar and command menu destinations, in display order, grouped for the desktop sidebar. */
export const navigation: { page: Page; icon: IconName; group: 'Pipeline' | 'Sales' | 'Grow' | 'Workspace' }[] = [
  { page: 'Overview', icon: 'grid', group: 'Pipeline' },
  { page: 'Leads', icon: 'users', group: 'Pipeline' },
  { page: 'Follow-ups', icon: 'calendar', group: 'Pipeline' },
  { page: 'Activity', icon: 'clock', group: 'Pipeline' },
  { page: 'Sales pipeline', icon: 'deal', group: 'Sales' },
  { page: 'Sales analytics', icon: 'chart', group: 'Sales' },
  { page: 'Discovery', icon: 'compass', group: 'Grow' },
  { page: 'Onboarding', icon: 'clipboard', group: 'Grow' },
  { page: 'Integrations', icon: 'spark', group: 'Workspace' },
  { page: 'Settings', icon: 'gear', group: 'Workspace' },
]
