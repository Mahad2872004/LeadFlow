import { DuckDBInstance } from '@duckdb/node-api'
const db=await DuckDBInstance.create('C:/Users/ADAN/AppData/Local/Temp/claude/f--leadFlow/8cad3e8c-cb93-41c5-a140-ac74f5bb5505/scratchpad/austin.duckdb');const c=await db.connect()
const q=async s=>(await c.runAndReadAll(s)).getRowObjectsJson()
await c.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
await c.run(`CREATE OR REPLACE TABLE austin AS SELECT * FROM read_parquet('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=places/type=place/*', hive_partitioning=1)
 WHERE bbox.xmin BETWEEN -97.94 AND -97.57 AND bbox.ymin BETWEEN 30.10 AND 30.52`)
console.log((await q("select count(*) n from austin"))[0])
const pats=['dent','law','attorney','real_estate','realtor','advertis','marketing','contractor','construction','builder','gym','fitness','clinic','doctor','physician','account','hair','beauty','salon','restaurant']
for(const p of pats){const r=await q(`select taxonomy.primary t, count(*)::int n from austin where taxonomy.primary like '%${p}%' group by 1 order by 2 desc limit 6`);console.log(p,'=>',r.map(x=>x.t+':'+x.n).join(', '))}
console.log(JSON.stringify(await q("select taxonomy.hierarchy h, basic_category b from austin where taxonomy.primary like '%dent%' limit 2")))
console.log(JSON.stringify(await q("select names.primary n, websites, phones, emails, addresses, confidence, operating_status, sources[1].update_time u from austin where taxonomy.primary like '%dent%' limit 2")).slice(0,1500))
