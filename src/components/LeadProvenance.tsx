import { useEffect, useState } from 'react'
import { cachedOrigins, domainOf, type LeadOrigin } from '../lib/discovery'
import { dateLabel } from '../lib/format'
import { countries, normalizeWebsite, type Lead } from '../lib/model'
const providerLabels: Record<string, string> = { openstreetmap: 'OpenStreetMap' }
/** A lead's business details, and where it came from when it was imported. */
export function LeadProvenance({workspaceId,lead}:{workspaceId:string;lead:Lead}){
  const [origin,setOrigin]=useState<LeadOrigin|null>(null)
  useEffect(()=>{
    let active=true
    cachedOrigins(workspaceId).then(items=>{if(active)setOrigin(items.find(item=>item.leadId===lead.id)??null)})
    return()=>{active=false}
  },[workspaceId,lead.id])
  const website=normalizeWebsite(lead.website??'')
  const place=[lead.address,lead.city,lead.region,lead.postcode,countries.find(([code])=>code===lead.country)?.[1]??lead.country].filter(Boolean).join(', ')
  if(!website&&!place&&!lead.industry&&!origin)return null
  return <dl className="lead-business">
    {lead.industry&&<div><dt>Industry</dt><dd>{lead.industry}</dd></div>}
    {website&&<div><dt>Website</dt><dd><a href={website} target="_blank" rel="noopener noreferrer nofollow">{domainOf(website)}</a></dd></div>}
    {place&&<div><dt>Location</dt><dd>{place}</dd></div>}
    {origin&&<div><dt>Origin</dt><dd>{origin.method==='csv'?`Imported from a CSV file on ${dateLabel(origin.importedAt)}`
      :<>Found with lead discovery ({providerLabels[origin.provider??'']??origin.provider}) on {dateLabel(origin.discoveredAt??origin.importedAt)}{origin.sourceUpdatedAt?`; source record last updated ${dateLabel(origin.sourceUpdatedAt)}`:''}. {origin.sourceUrl&&<a href={origin.sourceUrl} target="_blank" rel="noopener noreferrer">View source record</a>}</>}</dd></div>}
  </dl>
}
