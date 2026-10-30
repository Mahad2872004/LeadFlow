-- Business directory loaded from Overture Maps places (CDLA Permissive 2.0 / Apache 2.0 by source), searched by the
-- "overture" discovery provider without calling any outside service. scripts/load-overture.mjs fills it.
-- * Only the service role can read or write it: signed-in users reach it through the discover-leads function, which
--   checks workspace membership first. It is shared reference data, not workspace data.
-- * A load replaces one release's rows country by country; nothing here is user-entered.
-- Reverse with supabase/rollbacks/202610310002_overture_directory.down.sql.

create table leadflow_private.directory_places (
  id text primary key check (length(id) between 1 and 100),
  category text not null check (category ~ '^[a-z_]{2,40}$'),
  taxonomy text not null default '' check (length(taxonomy) <= 100),
  name text not null check (length(name) between 1 and 150),
  website text not null default '' check (website = '' or (length(website) <= 300 and website ~* '^https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$')),
  phone text not null default '' check (length(phone) <= 25),
  email text not null default '' check (length(email) <= 150),
  address text not null default '' check (length(address) <= 300),
  city text not null default '' check (length(city) <= 100),
  region text not null default '' check (length(region) <= 100),
  postcode text not null default '' check (length(postcode) <= 20),
  country text not null check (country ~ '^[A-Z]{2}$'),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  confidence real check (confidence between 0 and 1),
  source_updated_at timestamptz,
  release text not null check (release ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$'),
  -- Normalized like leadflow_private.lead_name_key, for exact city and postcode matching.
  city_key text generated always as (regexp_replace(lower(city), '[^a-z0-9]+', '', 'g')) stored,
  postcode_key text generated always as (regexp_replace(lower(postcode), '[^a-z0-9]+', '', 'g')) stored
);
create index directory_places_city on leadflow_private.directory_places(country, city_key, category);
create index directory_places_postcode on leadflow_private.directory_places(country, postcode_key);
create index directory_places_position on leadflow_private.directory_places(country, lat, lon);
alter table leadflow_private.directory_places enable row level security;
revoke all on leadflow_private.directory_places from public, anon, authenticated;

-- Upserts up to 1,000 rows of one release. Called by the loader with the service role key.
create function public.directory_load(release_id text, rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare inserted integer;
begin
  if release_id is null or release_id !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$' or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) > 1000 then
    raise exception 'Send up to 1,000 rows with a release identifier.' using errcode = '22023';
  end if;
  insert into leadflow_private.directory_places(id, category, taxonomy, name, website, phone, email, address, city, region, postcode, country, lat, lon, confidence, source_updated_at, release)
    select x.id, x.category, coalesce(x.taxonomy, ''), x.name, coalesce(x.website, ''), coalesce(x.phone, ''), coalesce(x.email, ''), coalesce(x.address, ''), coalesce(x.city, ''),
      coalesce(x.region, ''), coalesce(x.postcode, ''), x.country, x.lat, x.lon, x.confidence, x.source_updated_at, release_id
    from jsonb_to_recordset(rows) as x(id text, category text, taxonomy text, name text, website text, phone text, email text, address text, city text, region text, postcode text,
      country text, lat double precision, lon double precision, confidence real, source_updated_at timestamptz)
  on conflict (id) do update set category = excluded.category, taxonomy = excluded.taxonomy, name = excluded.name, website = excluded.website, phone = excluded.phone,
    email = excluded.email, address = excluded.address, city = excluded.city, region = excluded.region, postcode = excluded.postcode, country = excluded.country,
    lat = excluded.lat, lon = excluded.lon, confidence = excluded.confidence, source_updated_at = excluded.source_updated_at, release = excluded.release;
  get diagnostics inserted = row_count;
  return inserted;
end $$;

-- After a complete load: removes rows of the loaded countries that the new release no longer has.
create function public.directory_finish_load(release_id text, countries text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  if release_id is null or countries is null or cardinality(countries) = 0 then raise exception 'Name the release and countries.' using errcode = '22023'; end if;
  delete from leadflow_private.directory_places p where p.country = any(countries) and p.release <> release_id;
  get diagnostics removed = row_count;
  return removed;
end $$;

-- What is loaded, for the provider's "is it set up" check and the operator.
create function public.directory_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('rows', count(*), 'countries', coalesce(jsonb_agg(distinct country), '[]'::jsonb), 'release', max(release))
  from leadflow_private.directory_places
$$;

-- One location of a search. A city matches the address locality (and the region, when given); a postcode searches a
-- radius around the average position of businesses with that postcode. categories and require are JSON arrays of
-- strings (empty means any). Returns { located, total, results }.
create function public.directory_search(country_code text, region_name text, city_name text, postcode_value text, radius_km integer,
  categories jsonb, keyword text, require jsonb, max_rows integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare wanted_city text := regexp_replace(lower(coalesce(city_name, '')), '[^a-z0-9]+', '', 'g');
  wanted_postcode text := regexp_replace(lower(coalesce(postcode_value, '')), '[^a-z0-9]+', '', 'g');
  wanted_region text := upper(btrim(coalesce(region_name, ''))); center_lat double precision; center_lon double precision; lat_span double precision; lon_span double precision; result jsonb;
begin
  if country_code !~ '^[A-Z]{2}$' or max_rows not between 1 and 1000 or radius_km not between 1 and 50 or (wanted_city = '' and wanted_postcode = '') then
    raise exception 'Invalid directory search.' using errcode = '22023';
  end if;
  if wanted_postcode <> '' then
    select avg(p.lat), avg(p.lon) into center_lat, center_lon from leadflow_private.directory_places p where p.country = country_code and p.postcode_key = wanted_postcode;
    if center_lat is null then return jsonb_build_object('located', false, 'total', 0, 'results', '[]'::jsonb); end if;
    lat_span := radius_km / 111.0; lon_span := radius_km / (111.0 * greatest(cos(radians(center_lat)), 0.01));
  elsif not exists (select 1 from leadflow_private.directory_places p where p.country = country_code and p.city_key = wanted_city
      and (wanted_region = '' or upper(p.region) = wanted_region)) then
    return jsonb_build_object('located', false, 'total', 0, 'results', '[]'::jsonb);
  end if;
  with matches as (
    select p.* from leadflow_private.directory_places p
    where p.country = country_code
      and (case when wanted_postcode <> '' then p.lat between center_lat - lat_span and center_lat + lat_span and p.lon between center_lon - lon_span and center_lon + lon_span
        -- Haversine distance in km.
        and 6371 * 2 * asin(sqrt(power(sin(radians(p.lat - center_lat) / 2), 2) + cos(radians(center_lat)) * cos(radians(p.lat)) * power(sin(radians(p.lon - center_lon) / 2), 2))) <= radius_km
        else p.city_key = wanted_city and (wanted_region = '' or upper(p.region) = wanted_region) end)
      and (keyword is null or keyword = '' or p.name ilike '%' || replace(replace(replace(keyword, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      and (coalesce(jsonb_array_length(categories), 0) = 0 or categories ? p.category)
      and (not coalesce(require, '[]'::jsonb) ? 'website' or p.website <> '')
      and (not coalesce(require, '[]'::jsonb) ? 'phone' or p.phone <> '')
      and (not coalesce(require, '[]'::jsonb) ? 'email' or p.email <> '')
  )
  select jsonb_build_object('located', true, 'total', (select count(*) from matches), 'results', coalesce(jsonb_agg(to_jsonb(m) - 'city_key' - 'postcode_key' - 'lat' - 'lon' order by m.name, m.id), '[]'::jsonb))
    into result from (select * from matches order by name, id limit max_rows) m;
  return result;
end $$;

revoke all on function public.directory_load(text, jsonb), public.directory_finish_load(text, text[]), public.directory_status(),
  public.directory_search(text, text, text, text, integer, jsonb, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.directory_load(text, jsonb), public.directory_finish_load(text, text[]), public.directory_status(),
  public.directory_search(text, text, text, text, integer, jsonb, text, jsonb, integer) to service_role;
