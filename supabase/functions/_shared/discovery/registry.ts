import { openStreetMap } from './openstreetmap.ts'
import { overture } from './overture.ts'
import type { DiscoveryProvider } from './types.ts'
/** Every discovery provider LeadFlow knows. Add a provider here after implementing DiscoveryProvider. */
// The first ready provider is the default in the search form.
export const discoveryProviders: DiscoveryProvider[] = [overture, openStreetMap]
