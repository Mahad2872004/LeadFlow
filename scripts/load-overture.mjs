// Loads Overture Maps places into leadflow_private.directory_places for the "overture" discovery provider.
//   npm run directory:load -- --dry-run                      counts and estimated size, writes nothing
//   npm run directory:load -- --countries US --regions TX     load one state
//   npm run directory:load -- --countries US,GB,AU            load everything LeadFlow searches
// Options: --countries US,GB,AU  --regions TX,CA (US/AU region codes; UK records rarely have one)  --categories dental,legal
//   --release 2026-10-21.0 (default: latest)  --min-confidence 0.5
// Needs SUPABASE_SERVICE_ROLE_KEY (Supabase dashboard → Project Settings → API keys) and SUPABASE_URL, or VITE_SUPABASE_URL
// in .env.local. Reads Overture's public S3 bucket anonymously; a country can take several minutes and some GB of transfer.
// A load replaces the loaded countries' rows from earlier releases. Re-run monthly: Overture keeps releases for 60 days.
import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { overtureCategories } from '../supabase/functions/_shared/discovery/overture.ts'
import { cleanEmail, cleanPhone, cleanText, cleanWebsite } from '../supabase/functions/_shared/discovery/normalize.ts'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback }
const list = value => value ? value.split(',').map(item => item.trim()).filter(Boolean) : []
const dryRun = args.includes('--dry-run')
const countries = list(option('countries', 'US,GB,AU')).map(code => code.toUpperCase())
const regions = list(option('regions', '')).map(code => code.toUpperCase().replace(/^(US|AU)-/, ''))
const chosen = list(option('categories', '')).length ? overtureCategories.filter(item => list(option('categories', '')).includes(item.id)) : overtureCategories
const minConfidence = Number(option('min-confidence', '0.5'))
const fail = message => { console.error(message); process.exit(1) }
if (!countries.length || countries.some(code => !['US', 'GB', 'AU'].includes(code))) fail('--countries must be from US, GB, AU.')
if (!chosen.length) fail(`--categories must be from: ${overtureCategories.map(item => item.id).join(', ')}`)
if (!(minConfidence >= 0 && minConfidence <= 1)) fail('--min-confidence must be between 0 and 1.')
if (regions.some(code => !/^[A-Z]{2,3}$/.test(code))) fail('--regions takes codes such as TX or NSW.')

// Coarse boxes let DuckDB skip files outside the chosen countries instead of scanning the whole world.
const boxes = { US: [[-125, 24.4, -66.9, 49.5], [-170, 51, -129, 71.5], [-160.5, 18.9, -154.7, 22.3]], GB: [[-8.7, 49.8, 1.8, 60.9]], AU: [[112.9, -43.7, 153.7, -10.6]] }
const sqlList = values => `[${values.map(value => `'${value.replace(/'/g, "''")}'`).join(', ')}]`
const inBoxes = countries.flatMap(code => boxes[code]).map(([xmin, ymin, xmax, ymax]) => `(bbox.xmin BETWEEN ${xmin} AND ${xmax} AND bbox.ymin BETWEEN ${ymin} AND ${ymax})`).join(' OR ')
const allTaxonomy = chosen.flatMap(item => item.taxonomy)

const instanceDir = join(tmpdir(), 'leadflow-overture'); if (!existsSync(instanceDir)) mkdirSync(instanceDir, { recursive: true })
const db = await DuckDBInstance.create(join(instanceDir, 'load.duckdb'))
const connection = await db.connect()
const rows = async sql => (await connection.runAndReadAll(sql)).getRowObjectsJson()
await connection.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
const release = option('release', '') || (await rows("SELECT latest FROM 'https://stac.overturemaps.org/catalog.json'"))[0].latest
if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release)) fail(`Unexpected release identifier ${release}.`)
console.log(`Overture release ${release}; countries ${countries.join(', ')}${regions.length ? `; regions ${regions.join(', ')}` : ''}; categories ${chosen.map(item => item.id).join(', ')}.`)
console.log('Reading Overture places (this is the slow part)…')
const started = Date.now()
await connection.run(`CREATE OR REPLACE TABLE picked AS
WITH source AS (
  SELECT id, names.primary AS name, taxonomy.primary AS taxonomy, taxonomy.hierarchy AS hierarchy, confidence,
    websites[1] AS website, phones[1] AS phone, emails[1] AS email,
    addresses[1].freeform AS address, addresses[1].locality AS city, addresses[1].region AS region, addresses[1].postcode AS postcode, addresses[1].country AS country,
    bbox.ymin AS lat, bbox.xmin AS lon, CAST(list_max(list_transform(sources, s -> CAST(s.update_time AS VARCHAR))) AS VARCHAR) AS updated
  FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*', hive_partitioning=1)
  WHERE (${inBoxes}) AND addresses[1].country IN (${countries.map(code => `'${code}'`).join(', ')})
    ${regions.length ? `AND upper(addresses[1].region) IN (${regions.map(code => `'${code}'`).join(', ')})` : ''}
    AND confidence >= ${minConfidence} AND coalesce(operating_status, 'open') <> 'permanently_closed'
    AND names.primary IS NOT NULL AND list_has_any(taxonomy.hierarchy, ${sqlList(allTaxonomy)})
), mapped AS (
  SELECT *, CASE ${chosen.map(item => `WHEN list_has_any(hierarchy, ${sqlList(item.taxonomy)}) THEN '${item.id}'`).join(' ')} END AS category FROM source
)
-- One record per business: Overture often has the same place from several sources. Keep the most confident.
SELECT * EXCLUDE (hierarchy), row_number() OVER (ORDER BY id) AS rn FROM mapped
QUALIFY row_number() OVER (PARTITION BY country, regexp_replace(lower(name), '[^a-z0-9]+', '', 'g'), coalesce(nullif(postcode, ''), lower(city), id) ORDER BY confidence DESC NULLS LAST, id) = 1`)
await connection.run('CREATE OR REPLACE TABLE picked AS SELECT * EXCLUDE (rn), row_number() OVER (ORDER BY id) AS rn FROM picked')
const total = Number((await rows('SELECT count(*) AS n FROM picked'))[0].n)
console.log(`${total.toLocaleString()} businesses after removing duplicates (${Math.round((Date.now() - started) / 1000)} s).`)
for (const row of await rows('SELECT country, category, count(*) AS n FROM picked GROUP BY ALL ORDER BY country, category')) console.log(`  ${row.country} ${row.category.padEnd(13)} ${Number(row.n).toLocaleString()}`)
const sample = await rows('SELECT avg(length(coalesce(name,\'\')||coalesce(website,\'\')||coalesce(email,\'\')||coalesce(address,\'\')||coalesce(city,\'\')||coalesce(postcode,\'\'))) AS bytes FROM picked')
// Row text plus fixed columns, tuple overhead and three indexes: a rough planning figure, not a measurement.
console.log(`Estimated database size: about ${Math.round(total * (Number(sample[0].bytes ?? 80) + 260) / 1048576)} MB.`)
if (dryRun || !total) { console.log(dryRun ? 'Dry run: nothing was written.' : 'Nothing to load.'); process.exit(0) }

const env = Object.fromEntries((existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '').split(/\r?\n/).map(line => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2].trim()]))
const url = process.env.SUPABASE_URL || env.VITE_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) fail('Set SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_URL, unless .env.local has VITE_SUPABASE_URL) to upload.')
async function call(name, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${new URL(url).origin}/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
      if (response.ok) return response.json()
      const detail = await response.text()
      if (response.status < 500 || attempt >= 4) throw new Error(`${name} failed: HTTP ${response.status} ${detail.slice(0, 300)}`)
    } catch (error) { if (attempt >= 4 || /failed: HTTP 4/.test(error.message)) throw error }
    await new Promise(resolve => setTimeout(resolve, attempt * 2000))
  }
}
const clean = row => {
  const name = cleanText(row.name ?? '', 150)
  if (!name || !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return null
  const updated = row.updated && Number.isFinite(Date.parse(row.updated)) ? new Date(row.updated).toISOString() : null
  return { id: String(row.id).slice(0, 100), category: row.category, taxonomy: cleanText(row.taxonomy ?? '', 100), name, website: cleanWebsite(row.website ?? ''), phone: cleanPhone(row.phone ?? ''),
    email: cleanEmail(row.email ?? ''), address: cleanText(row.address ?? '', 300), city: cleanText(row.city ?? '', 100), region: cleanText(row.region ?? '', 100),
    postcode: cleanText(row.postcode ?? '', 20), country: row.country, lat: row.lat, lon: row.lon, confidence: row.confidence, source_updated_at: updated }
}
const batch = 1000, workers = 4
let next = 1, uploaded = 0
async function worker() {
  while (next <= total) {
    const from = next; next += batch
    const chunk = (await connection.runAndReadAll(`SELECT * EXCLUDE (rn) FROM picked WHERE rn BETWEEN ${from} AND ${from + batch - 1}`)).getRowObjects()
      .map(row => clean({ ...row, lat: Number(row.lat), lon: Number(row.lon), confidence: row.confidence === null ? null : Number(row.confidence) })).filter(Boolean)
    await call('directory_load', { release_id: release, rows: chunk })
    uploaded += chunk.length
    process.stdout.write(`\rUploaded ${uploaded.toLocaleString()} of ${total.toLocaleString()}`)
  }
}
await Promise.all(Array.from({ length: workers }, worker))
const removed = await call('directory_finish_load', { release_id: release, countries })
console.log(`\nDone. Removed ${removed} rows from earlier releases. Directory: ${JSON.stringify(await call('directory_status', {}))}`)
