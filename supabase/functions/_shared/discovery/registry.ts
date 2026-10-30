import { openStreetMap } from './openstreetmap.ts'
import type { DiscoveryProvider } from './types.ts'
/** Every discovery provider LeadFlow knows. Add a provider here after implementing DiscoveryProvider. */
export const discoveryProviders: DiscoveryProvider[] = [openStreetMap]
