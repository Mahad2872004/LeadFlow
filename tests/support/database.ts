import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
const directory = 'supabase/migrations'
/** Migration files in the order the Supabase CLI applies them. */
export const migrations = readdirSync(directory).filter(name => /^\d+_\w+\.sql$/.test(name)).sort()
export const migrationSql = (name: string) => readFileSync(`${directory}/${name}`, 'utf8')
/**
 * Embedded PostgreSQL with stand-ins for what hosted Supabase provides: API roles, auth.users,
 * auth.uid()/auth.jwt() read from PostgREST's request settings, and the default grants Supabase gives
 * anon/authenticated on new public tables and functions, so a missing revoke fails the tests.
 */
export async function createDatabase(users: string[] = [], applied: string[] = migrations) {
  const db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const id of users) await db.query('insert into auth.users(id) values ($1)', [id])
  for (const name of applied) await db.exec(migrationSql(name))
  return db
}
/** Act as an API request: the database role plus the JWT claims PostgREST sets. `postgres` acts as the operator. */
export async function actAs(db: PGlite, user: string | null, role = 'authenticated', claims: Record<string, unknown> = {}) {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [user ?? '', JSON.stringify({ ...claims, ...(user ? { sub: user } : {}), role })])
  if (role !== 'postgres') await db.exec(`set role ${role}`)
}
