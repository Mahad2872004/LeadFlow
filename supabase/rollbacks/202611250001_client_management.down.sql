-- Reverses 202611250001_client_management.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611250001
-- Deletes every client, client contact, agreed service, requirement and revision, scope confirmation, client activity,
-- onboarding completion, form, form assignment, internal step, submission history, onboarding stage and document record,
-- and the follow-up tasks that belonged to clients. Stored files are not deleted from the client-documents bucket; remove
-- them (or the bucket) in Supabase Storage. Onboarding requests and their M6A items stay; items of the new field types
-- (email, phone, URL, number, date, multiple choice, checkbox, file, heading, instructions) are removed, and templates and
-- requests for the website and automation services become "other". Leads, deals and their history are not touched.

-- 1. Data the restored constraints would reject.
delete from public.follow_up_tasks where "leadId" is null;
update public.follow_up_tasks set "taskType" = 'custom' where "taskType" in ('welcome','request_info','review_form','collect_assets','review_requirements','confirm_scope','verify_integrations','prepare_handoff');
delete from leadflow_private.deal_activities where kind = 'client_converted';
delete from leadflow_private.onboarding_items where kind not in ('text','choice','links','access');
delete from leadflow_private.onboarding_template_items where kind not in ('text','choice','links','access');
update leadflow_private.onboarding_templates set starter_key = null where starter_key in ('website','marketing','automation');
update leadflow_private.onboarding_templates set service_type = 'other' where service_type in ('website','automation');
update leadflow_private.onboarding_requests set service_type = 'other' where service_type in ('website','automation');

-- 2. The M6A and M9 functions as they were.
create or replace function leadflow_private.is_onboarding_service(candidate text) returns boolean language sql immutable set search_path = '' as $$
  select candidate in ('paid_ads','seo','social','email','other')
$$;
create or replace function leadflow_private.onboarding_clean_item(item jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare item_kind text; raw_options jsonb; clean_options jsonb := '[]'; option_count integer;
begin
  if item is null or jsonb_typeof(item) <> 'object' then raise exception 'Each checklist item must be an object.' using errcode = '22023'; end if;
  item_kind := item->>'kind';
  if item_kind is null or item_kind not in ('text','choice','links','access') then raise exception 'Choose a type for each checklist item.' using errcode = '22023'; end if;
  if item ? 'required' and jsonb_typeof(item->'required') <> 'boolean' then raise exception 'Mark each item as required or optional.' using errcode = '22023'; end if;
  raw_options := coalesce(item->'options', '[]');
  if jsonb_typeof(raw_options) <> 'array' then raise exception 'Options must be a list.' using errcode = '22023'; end if;
  if item_kind = 'choice' then
    option_count := jsonb_array_length(raw_options);
    if option_count not between 2 and 20 then raise exception 'Choice items need 2 to 20 options.' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements(raw_options) o where jsonb_typeof(o) <> 'string') then raise exception 'Options must be text.' using errcode = '22023'; end if;
    select jsonb_agg(leadflow_private.onboarding_clean_text(o #>> '{}', 'Each option', 100, true) order by n) into clean_options from jsonb_array_elements(raw_options) with ordinality as e(o, n);
    if (select count(distinct lower(o #>> '{}')) from jsonb_array_elements(clean_options) o) <> option_count then
      raise exception 'Choice options must all be different.' using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object(
    'section', coalesce(nullif(leadflow_private.onboarding_clean_text(item->>'section', 'Section', 60), ''), 'General'),
    'title', leadflow_private.onboarding_clean_text(item->>'title', 'Item title', 200, true),
    'guidance', leadflow_private.onboarding_clean_text(item->>'guidance', 'Guidance', 2000, false, false),
    'kind', item_kind, 'options', clean_options,
    'required', coalesce((item->>'required')::boolean, true),
    'dueDate', leadflow_private.onboarding_clean_date(item->>'dueDate', 'Item due date'));
end $$;
create or replace function leadflow_private.onboarding_readiness(target_request uuid) returns jsonb
language sql stable set search_path = '' as $$
  with request as (select * from leadflow_private.onboarding_requests where id = target_request),
  items as (select * from leadflow_private.onboarding_items where request_id = target_request),
  blockers as (select * from items where required and state not in ('accepted','not_required')),
  totals as (select count(*) filter (where required) as required_total,
      count(*) filter (where required and state = 'accepted') as required_accepted,
      count(*) filter (where required and state = 'not_required') as required_waived,
      count(*) filter (where not required) as optional_total,
      count(*) filter (where not required and state not in ('accepted','not_required')) as optional_open
    from items)
  select jsonb_build_object(
    'state', case r.status when 'draft' then 'not_open' when 'cancelled' then 'cancelled' when 'completed' then 'handed_off' when 'paused' then 'paused'
      else case when not exists (select 1 from blockers) then 'ready'
        when exists (select 1 from blockers where state in ('not_started','changes_requested')) then 'waiting_on_client'
        else 'awaiting_review' end end,
    'requirementsMet', not exists (select 1 from blockers),
    'requiredTotal', t.required_total, 'requiredAccepted', t.required_accepted, 'requiredWaived', t.required_waived,
    'optionalTotal', t.optional_total, 'optionalOutstanding', t.optional_open,
    'percent', case when t.required_total = 0 then 100 else floor(100.0 * (t.required_accepted + t.required_waived) / t.required_total)::integer end,
    'blockers', coalesce((select jsonb_agg(jsonb_build_object('itemId', b.id, 'title', b.title, 'state', b.state, 'kind', b.kind,
        'waitingOn', case when b.state = 'submitted' then 'agency' else 'client' end,
        'reason', case b.state
          when 'not_started' then 'Not yet provided by the client'
          when 'changes_requested' then 'Changes requested from the client'
          when 'submitted' then case when b.kind = 'access' then 'Client reports access granted; the agency has not confirmed it' else 'Submitted; waiting for agency review' end end)
        order by b.position) from blockers b), '[]'))
  from request r cross join totals t
$$;
create or replace function leadflow_private.refresh_onboarding(target_request uuid) returns void
language plpgsql set search_path = '' as $$
declare request leadflow_private.onboarding_requests; met boolean; client_open integer; link_ok boolean;
begin
  select * into request from leadflow_private.onboarding_requests where id = target_request;
  met := not exists (select 1 from leadflow_private.onboarding_items i where i.request_id = target_request and i.required and i.state not in ('accepted','not_required'));
  if request.status = 'active' and met and request.ready_since is null then
    update leadflow_private.onboarding_requests set ready_since = now() where id = target_request;
    perform leadflow_private.onboarding_event(target_request, null, 'system', null, 'became_ready', jsonb_build_object('requiredItems', (select count(*) from leadflow_private.onboarding_items i where i.request_id = target_request and i.required)));
  elsif not met and request.ready_since is not null and request.status in ('active','paused') then
    update leadflow_private.onboarding_requests set ready_since = null where id = target_request;
    perform leadflow_private.onboarding_event(target_request, null, 'system', null, 'readiness_lost', '{}');
  end if;
  select count(*) into client_open from leadflow_private.onboarding_items i where i.request_id = target_request and i.required and i.state in ('not_started','changes_requested');
  link_ok := exists (select 1 from leadflow_private.onboarding_links l where l.request_id = target_request and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now());
  if request.status = 'active' and request.reminder_interval_days is not null and request.contact_email is not null
    and request.reminders_scheduled < request.reminder_max and client_open > 0 and link_ok then
    update leadflow_private.onboarding_requests set next_reminder_at = now() + make_interval(days => request.reminder_interval_days)
      where id = target_request and next_reminder_at is null;
  else
    update leadflow_private.onboarding_requests set next_reminder_at = null where id = target_request and next_reminder_at is not null;
  end if;
end $$;
create or replace function leadflow_private.onboarding_starter_items(service text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_array(
    jsonb_build_object('section','Business','title','Business overview and goals','kind','text','required',true,'guidance','Describe what you sell, who you sell to, and what you want this engagement to achieve in the first 90 days.'),
    jsonb_build_object('section','Business','title','Main point of contact and approver','kind','text','required',true,'guidance','Name, role and email of the person we work with day to day, and of the person who approves campaigns and spend if different.'),
    jsonb_build_object('section','Business','title','Target audience and geographic market','kind','text','required',true,'guidance','Who your best customers are, and the countries, regions or cities we should target or avoid.'),
    jsonb_build_object('section','Brand','title','Brand guidelines and logo files','kind','links','required',true,'guidance','Links to your brand guidelines, logos and fonts in your own storage (for example Google Drive, Dropbox or OneDrive). Make sure the links are shared with us.'),
    jsonb_build_object('section','Brand','title','Website and other relevant resources','kind','links','required',true,'guidance','Your website and any pages, documents or examples we should know about.'),
    jsonb_build_object('section','Working together','title','Communication and approval preferences','kind','choice','required',true,'options',jsonb_build_array('Email','Shared Slack or Teams channel','Scheduled video calls','Our project management tool'),'guidance','How you prefer to receive updates and approve work. Add anything else in the note.'))
  || case service
    when 'paid_ads' then jsonb_build_array(
      jsonb_build_object('section','Advertising','title','Advertising objectives','kind','text','required',true,'guidance','What success looks like: leads, sales, bookings or awareness, and any target cost per result.'),
      jsonb_build_object('section','Advertising','title','Monthly budget and campaign priorities','kind','text','required',true,'guidance','Monthly media budget, how it should be split between platforms or products, and which campaigns come first.'),
      jsonb_build_object('section','Access','title','Ad account access (Google Ads and/or Meta)','kind','access','required',true,'guidance','Grant access using the platform''s own sharing: add our team as a user or link our manager account in Google Ads, and assign our business as a partner in Meta Business Suite. Never send passwords. We will confirm once access works.'),
      jsonb_build_object('section','Access','title','Conversion tracking and analytics access','kind','access','required',true,'guidance','Add our email as a user in Google Analytics (Admin → property access management) and, if used, Google Tag Manager. Never send passwords.'),
      jsonb_build_object('section','Assets','title','Existing campaigns and performance references','kind','links','required',false,'guidance','Past reports, exports or screenshots of campaign performance, if you have them.'),
      jsonb_build_object('section','Assets','title','Landing pages and creative assets','kind','links','required',true,'guidance','Landing page URLs and links to images, videos and ad copy we can use.'))
    when 'seo' then jsonb_build_array(
      jsonb_build_object('section','SEO','title','Target services, locations and keywords','kind','text','required',true,'guidance','The services and locations that matter most, and any keywords you already track.'),
      jsonb_build_object('section','Access','title','Website and analytics access','kind','access','required',true,'guidance','Invite our team as a user in your website platform and in Google Analytics using their own user-management screens. Never send passwords.'),
      jsonb_build_object('section','Access','title','Google Search Console access','kind','access','required',true,'guidance','In Search Console, open Settings → Users and permissions and add our email. Never send passwords.'),
      jsonb_build_object('section','SEO','title','Existing SEO reports or baseline data','kind','links','required',false,'guidance','Previous audits, rank reports or exports, if any.'),
      jsonb_build_object('section','SEO','title','Priority pages and competitors','kind','text','required',true,'guidance','The pages that matter most to your business and the competitors you compare yourself with.'))
    when 'social' then jsonb_build_array(
      jsonb_build_object('section','Social','title','Platforms and profiles in scope','kind','text','required',true,'guidance','Which platforms we will manage, with links to each profile.'),
      jsonb_build_object('section','Social','title','Content goals','kind','text','required',true,'guidance','What the content should achieve and any themes, products or messages to focus on.'),
      jsonb_build_object('section','Social','title','Posting frequency','kind','choice','required',true,'options',jsonb_build_array('1–2 posts per week','3–4 posts per week','Daily','Not sure yet'),'guidance','How often you expect us to post. Add platform-specific needs in the note.'),
      jsonb_build_object('section','Social','title','Brand voice and content guidelines','kind','text','required',true,'guidance','How your brand sounds, words or topics to avoid, and anything that needs legal or compliance review.'),
      jsonb_build_object('section','Assets','title','Content assets and upcoming campaigns','kind','links','required',false,'guidance','Photos, videos and dates of launches or events we should plan around.'),
      jsonb_build_object('section','Access','title','Account access and approval process','kind','access','required',true,'guidance','Grant access through each platform''s business tools (for example Meta Business Suite partners or LinkedIn Page admins). Never send passwords. Note who approves posts in the note.'))
    when 'email' then jsonb_build_array(
      jsonb_build_object('section','Access','title','Email platform and account access','kind','access','required',true,'guidance','Invite our team as a user from your email platform''s team or user settings. Never send passwords or API keys.'),
      jsonb_build_object('section','Email','title','Audience lists and consent requirements','kind','text','required',true,'guidance','Describe your lists or segments and how subscribers gave consent. Do not upload or paste subscriber data here.'),
      jsonb_build_object('section','Email','title','Existing campaigns and performance references','kind','links','required',false,'guidance','Recent campaigns or reports, if available.'),
      jsonb_build_object('section','Email','title','Brand templates and campaign goals','kind','text','required',true,'guidance','Links or notes about existing templates, and what the email programme should achieve.'),
      jsonb_build_object('section','Email','title','Approval and sending requirements','kind','text','required',true,'guidance','Who approves each send, sending times or days to avoid, and any legal footer requirements.'))
    else '[]'::jsonb end
$$;
create or replace function public.onboarding_overview_for(target_workspace uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; today date;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select (now() at time zone s.timezone)::date into today from public.workspace_settings s where s.workspace_id = target_workspace;
  select jsonb_build_object('today', today,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(nullif(p.display_name, ''), u.email::text, 'Member')) order by coalesce(nullif(p.display_name, ''), u.email::text))
      from public.workspace_memberships m join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.workspace_id = target_workspace), '[]'),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'serviceType', t.service_type, 'description', t.description, 'starterKey', t.starter_key,
        'archived', t.archived, 'version', t.version, 'updatedAt', t.updated_at,
        'itemCount', (select count(*) from leadflow_private.onboarding_template_items ti where ti.template_id = t.id),
        'requiredCount', (select count(*) from leadflow_private.onboarding_template_items ti where ti.template_id = t.id and ti.required)) order by t.archived, t.name)
      from leadflow_private.onboarding_templates t where t.workspace_id = target_workspace), '[]'),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'clientName', r.client_name, 'serviceType', r.service_type,
        'ownerId', r.owner_id, 'status', r.status, 'version', r.version, 'startDate', r.start_date, 'targetKickoffDate', r.target_kickoff_date, 'dueDate', r.due_date,
        'createdAt', r.created_at, 'updatedAt', r.updated_at, 'readySince', r.ready_since, 'nextReminderAt', r.next_reminder_at,
        'hasActiveLink', exists (select 1 from leadflow_private.onboarding_links l where l.request_id = r.id and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now()),
        'counts', (select jsonb_build_object('total', count(*),
            'requiredOutstanding', count(*) filter (where i.required and i.state not in ('accepted','not_required')),
            'awaitingReview', count(*) filter (where i.state = 'submitted'),
            'changesRequested', count(*) filter (where i.state = 'changes_requested'),
            'overdue', count(*) filter (where i.required and i.state not in ('accepted','not_required') and coalesce(i.due_date, r.due_date) < today))
          from leadflow_private.onboarding_items i where i.request_id = r.id),
        'readiness', leadflow_private.onboarding_readiness(r.id)) order by r.created_at desc, r.id)
      from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace), '[]'))
  into result;
  return result;
end $$;
create or replace function public.onboarding_request_for(target_workspace uuid, target_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; result jsonb; today date; client_open integer; link_ok boolean;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select * into request from leadflow_private.onboarding_requests r where r.id = target_request and r.workspace_id = target_workspace;
  if not found then raise exception 'Onboarding request not found in this workspace.' using errcode = 'P0002'; end if;
  select (now() at time zone s.timezone)::date into today from public.workspace_settings s where s.workspace_id = target_workspace;
  select count(*) into client_open from leadflow_private.onboarding_items i where i.request_id = request.id and i.required and i.state in ('not_started','changes_requested');
  link_ok := exists (select 1 from leadflow_private.onboarding_links l where l.request_id = request.id and l.purpose = 'shared' and l.revoked_at is null and l.expires_at > now());
  select jsonb_build_object('id', request.id, 'title', request.title, 'clientName', request.client_name, 'contactName', request.contact_name, 'contactEmail', request.contact_email,
    'serviceType', request.service_type, 'ownerId', request.owner_id, 'status', request.status, 'version', request.version,
    'startDate', request.start_date, 'targetKickoffDate', request.target_kickoff_date, 'dueDate', request.due_date, 'today', today,
    'templateId', request.template_id, 'templateName', request.template_name, 'leadId', request.lead_id,
    'leadExists', request.lead_id is not null and exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = request.lead_id),
    'clientInstructions', request.client_instructions, 'internalNote', request.internal_note, 'cancelReason', request.cancel_reason,
    'createdAt', request.created_at, 'updatedAt', request.updated_at, 'activatedAt', request.activated_at, 'completedAt', request.completed_at, 'cancelledAt', request.cancelled_at,
    'readySince', request.ready_since, 'readiness', leadflow_private.onboarding_readiness(request.id),
    'reminders', jsonb_build_object('intervalDays', request.reminder_interval_days, 'max', request.reminder_max, 'scheduled', request.reminders_scheduled, 'nextAt', request.next_reminder_at,
      'blockedBy', case when request.status <> 'active' then 'not_active' when request.reminder_interval_days is null then 'disabled'
        when request.contact_email is null then 'no_email' when request.reminders_scheduled >= request.reminder_max then 'max_reached'
        when client_open = 0 then 'nothing_outstanding' when not link_ok then 'no_link' end,
      'history', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sequence', m.sequence, 'status', m.status, 'recipient', m.recipient, 'itemCount', m.item_count,
          'attempts', m.attempts, 'createdAt', m.created_at, 'updatedAt', m.updated_at, 'lastError', m.last_error) order by m.sequence)
        from leadflow_private.onboarding_reminders m where m.request_id = request.id), '[]')),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'position', i.position, 'section', i.section, 'title', i.title, 'guidance', i.guidance, 'kind', i.kind,
        'options', i.options, 'required', i.required, 'dueDate', i.due_date, 'state', i.state, 'response', i.response, 'hasDraft', i.draft is not null,
        'revision', i.revision, 'submittedAt', i.submitted_at, 'reviewedAt', i.reviewed_at, 'clientFeedback', i.client_feedback, 'waiveReason', i.waive_reason,
        'internalNote', i.internal_note, 'overdue', i.required and i.state not in ('accepted','not_required') and coalesce(i.due_date, request.due_date) < today) order by i.position)
      from leadflow_private.onboarding_items i where i.request_id = request.id), '[]'),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'purpose', l.purpose, 'createdAt', l.created_at, 'expiresAt', l.expires_at, 'revokedAt', l.revoked_at,
        'lastUsedAt', l.last_used_at, 'active', l.revoked_at is null and l.expires_at > now()) order by l.created_at desc)
      from leadflow_private.onboarding_links l where l.request_id = request.id), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'actorType', e.actor_type,
        'actorName', case e.actor_type when 'member' then coalesce(nullif(p.display_name, ''), u.email::text, 'Former member') when 'client' then 'Client' else 'LeadFlow' end,
        'itemId', e.item_id, 'itemTitle', i.title, 'detail', e.detail, 'at', e.at) order by e.at desc, e.id desc)
      from (select * from leadflow_private.onboarding_events where request_id = request.id order by at desc, id desc limit 300) e
      left join public.profiles p on p.id = e.actor_id left join auth.users u on u.id = e.actor_id
      left join leadflow_private.onboarding_items i on i.request_id = e.request_id and i.id = e.item_id), '[]'),
    'handoff', (select jsonb_build_object('id', h.id, 'handedOffAt', h.handed_off_at, 'note', h.note, 'requestVersion', h.request_version,
        'handedOffBy', coalesce(nullif(p.display_name, ''), u.email::text, 'Former member'))
      from leadflow_private.onboarding_handoffs h left join public.profiles p on p.id = h.handed_off_by left join auth.users u on u.id = h.handed_off_by where h.request_id = request.id))
  into result;
  return result;
end $$;
create or replace function public.onboarding_template_for(target_workspace uuid, target_template uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member']);
  select jsonb_build_object('id', t.id, 'name', t.name, 'serviceType', t.service_type, 'description', t.description, 'starterKey', t.starter_key, 'archived', t.archived, 'version', t.version,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', ti.id, 'section', ti.section, 'title', ti.title, 'guidance', ti.guidance, 'kind', ti.kind, 'options', ti.options, 'required', ti.required) order by ti.position)
      from leadflow_private.onboarding_template_items ti where ti.template_id = t.id), '[]'))
  into result from leadflow_private.onboarding_templates t where t.id = target_template and t.workspace_id = target_workspace;
  if result is null then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  return result;
end $$;
create or replace function public.install_starter_templates(target_workspace uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare added integer := 0; starter record; created uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  for starter in select * from (values ('paid_ads','Paid advertising onboarding','Ad account access, tracking, budget and creative needed before the first campaign.'),
      ('seo','SEO onboarding','Access, keywords, priority pages and baseline data needed before SEO work starts.'),
      ('social','Social media management onboarding','Profiles, content goals, brand voice and access needed before the first posts.'),
      ('email','Email marketing onboarding','Platform access, audience consent, templates and approvals needed before the first send.')) as s(key, name, description)
  loop
    insert into leadflow_private.onboarding_templates(workspace_id, name, service_type, description, starter_key)
      values (target_workspace, starter.name, starter.key, starter.description, starter.key) on conflict (workspace_id, starter_key) do nothing returning id into created;
    if created is not null then
      insert into leadflow_private.onboarding_template_items(workspace_id, template_id, position, section, title, guidance, kind, options, required)
        select target_workspace, created, (n - 1)::integer, c->>'section', c->>'title', c->>'guidance', c->>'kind', c->'options', (c->>'required')::boolean
        from jsonb_array_elements(leadflow_private.onboarding_starter_items(starter.key)) with ordinality as e(raw, n)
        cross join lateral (select leadflow_private.onboarding_clean_item(e.raw) as c) cleaned;
      added := added + 1;
    end if;
    created := null;
  end loop;
  return added;
end $$;
create or replace function public.save_onboarding_template(target_workspace uuid, definition jsonb, expected_version integer default null, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing leadflow_private.onboarding_templates; target uuid; clean_name text; clean_description text; items jsonb; item_count integer;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin'], true);
  if definition is null or jsonb_typeof(definition) <> 'object' then raise exception 'Send the template as an object.' using errcode = '22023'; end if;
  clean_name := leadflow_private.onboarding_clean_text(definition->>'name', 'Template name', 100, true);
  clean_description := leadflow_private.onboarding_clean_text(definition->>'description', 'Description', 1000, false, false);
  if not leadflow_private.is_onboarding_service(definition->>'serviceType') then raise exception 'Choose a service type.' using errcode = '22023'; end if;
  if jsonb_typeof(definition->'items') is distinct from 'array' then raise exception 'Add the template''s checklist items.' using errcode = '22023'; end if;
  item_count := jsonb_array_length(definition->'items');
  if item_count not between 1 and 100 then raise exception 'A template needs 1 to 100 items.' using errcode = '22023'; end if;
  select jsonb_agg(leadflow_private.onboarding_clean_item(raw) order by n) into items from jsonb_array_elements(definition->'items') with ordinality as e(raw, n);
  if nullif(definition->>'id', '') is null then
    if request_id is not null then
      select * into existing from leadflow_private.onboarding_templates t where t.workspace_id = target_workspace and t.creation_request_id = save_onboarding_template.request_id;
      if found then
        if existing.name <> clean_name then raise exception 'This request already created a different template.' using errcode = '23505'; end if;
        return jsonb_build_object('id', existing.id, 'version', existing.version);
      end if;
    end if;
    if (select count(*) from leadflow_private.onboarding_templates t where t.workspace_id = target_workspace) >= 50 then
      raise exception 'A workspace can have at most 50 templates. Archive or reuse one instead.' using errcode = '54000';
    end if;
    insert into leadflow_private.onboarding_templates(workspace_id, name, service_type, description, creation_request_id)
      values (target_workspace, clean_name, definition->>'serviceType', clean_description, request_id) returning * into existing;
  else
    if definition->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
    target := (definition->>'id')::uuid;
    select * into existing from leadflow_private.onboarding_templates t where t.id = target and t.workspace_id = target_workspace for update;
    if not found then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
    if expected_version is null or existing.version <> expected_version then
      raise exception 'This template was changed in another session. Reload it and try again.' using errcode = '40001';
    end if;
    update leadflow_private.onboarding_templates set name = clean_name, service_type = definition->>'serviceType', description = clean_description, version = version + 1
      where id = target returning * into existing;
    delete from leadflow_private.onboarding_template_items where template_id = target;
  end if;
  insert into leadflow_private.onboarding_template_items(workspace_id, template_id, position, section, title, guidance, kind, options, required)
    select target_workspace, existing.id, (n - 1)::integer, c->>'section', c->>'title', c->>'guidance', c->>'kind', c->'options', (c->>'required')::boolean
    from jsonb_array_elements(items) with ordinality as e(c, n);
  return jsonb_build_object('id', existing.id, 'version', existing.version);
end $$;
create or replace function public.create_onboarding_request(target_workspace uuid, details jsonb, request_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := leadflow_private.valid_actor(); existing leadflow_private.onboarding_requests; source leadflow_private.onboarding_templates; created uuid := gen_random_uuid(); template_ref uuid;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null then raise exception 'Missing request identity.' using errcode = '22023'; end if;
  if details is null or jsonb_typeof(details) <> 'object' then raise exception 'Send the request details as an object.' using errcode = '22023'; end if;
  select * into existing from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace and r.creation_request_id = create_onboarding_request.request_id;
  if found then
    if existing.title <> leadflow_private.onboarding_clean_text(details->>'title', 'Project name', 150, true) then
      raise exception 'This request already created a different onboarding request.' using errcode = '23505';
    end if;
    return existing.id;
  end if;
  if (select count(*) from leadflow_private.onboarding_requests r where r.workspace_id = target_workspace) >= 1000 then
    raise exception 'A workspace can have at most 1,000 onboarding requests.' using errcode = '54000';
  end if;
  if nullif(details->>'templateId', '') is not null then
    if details->>'templateId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
    template_ref := (details->>'templateId')::uuid;
    select * into source from leadflow_private.onboarding_templates t where t.id = template_ref and t.workspace_id = target_workspace and not t.archived;
    if not found then raise exception 'Template not found in this workspace.' using errcode = 'P0002'; end if;
  end if;
  insert into leadflow_private.onboarding_requests(id, workspace_id, title, client_name, service_type, template_id, template_name, created_by, owner_id, creation_request_id)
    values (created, target_workspace, leadflow_private.onboarding_clean_text(details->>'title', 'Project name', 150, true),
      leadflow_private.onboarding_clean_text(details->>'clientName', 'Client name', 150, true), coalesce(source.service_type, 'other'),
      source.id, source.name, actor, actor, request_id);
  perform leadflow_private.write_onboarding_details(created, details - 'templateId');
  insert into leadflow_private.onboarding_items(workspace_id, request_id, position, section, title, guidance, kind, options, required)
    select target_workspace, created, ti.position, ti.section, ti.title, ti.guidance, ti.kind, ti.options, ti.required
    from leadflow_private.onboarding_template_items ti where ti.template_id = source.id;
  perform leadflow_private.onboarding_event(created, null, 'member', actor, 'created',
    jsonb_build_object('template', source.name, 'items', (select count(*) from leadflow_private.onboarding_items i where i.request_id = created)));
  return created;
end $$;
create or replace function public.save_onboarding_item(target_workspace uuid, target_request uuid, item jsonb, expected_version integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; clean jsonb; existing leadflow_private.onboarding_items; target uuid; internal text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, expected_version);
  perform leadflow_private.require_open_onboarding(request);
  clean := leadflow_private.onboarding_clean_item(item);
  internal := leadflow_private.onboarding_clean_text(item->>'internalNote', 'Internal note', 2000, false, false);
  if nullif(item->>'id', '') is null then
    if (select count(*) from leadflow_private.onboarding_items i where i.request_id = target_request) >= 100 then
      raise exception 'A request can have at most 100 items.' using errcode = '54000';
    end if;
    insert into leadflow_private.onboarding_items(workspace_id, request_id, position, section, title, guidance, kind, options, required, due_date, internal_note)
      values (target_workspace, target_request, coalesce((select max(i.position) + 1 from leadflow_private.onboarding_items i where i.request_id = target_request), 0),
        clean->>'section', clean->>'title', clean->>'guidance', clean->>'kind', clean->'options', (clean->>'required')::boolean, (clean->>'dueDate')::date, internal)
      returning id into target;
    perform leadflow_private.onboarding_event(target_request, target, 'member', leadflow_private.valid_actor(), 'item_added', jsonb_build_object('title', clean->>'title', 'required', clean->'required'));
  else
    if item->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
    target := (item->>'id')::uuid;
    select * into existing from leadflow_private.onboarding_items i where i.request_id = target_request and i.id = target for update;
    if not found then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
    if (existing.response is not null or existing.draft is not null) and (existing.kind <> clean->>'kind' or existing.options <> clean->'options') then
      raise exception 'The client has already answered this item, so its type and options cannot change. Mark it not required and add a new item instead.' using errcode = '55000';
    end if;
    update leadflow_private.onboarding_items set section = clean->>'section', title = clean->>'title', guidance = clean->>'guidance', kind = clean->>'kind', options = clean->'options',
      required = (clean->>'required')::boolean, due_date = (clean->>'dueDate')::date, internal_note = internal, revision = revision + 1
      where request_id = target_request and id = target;
    perform leadflow_private.onboarding_event(target_request, target, 'member', leadflow_private.valid_actor(), 'item_updated',
      jsonb_build_object('title', clean->>'title', 'required', clean->'required', 'requiredChanged', existing.required <> (clean->>'required')::boolean));
  end if;
  update leadflow_private.onboarding_requests set version = version + 1 where id = target_request;
  perform leadflow_private.refresh_onboarding(target_request);
  return target;
end $$;
create or replace function public.review_onboarding_item(target_workspace uuid, target_request uuid, target_item uuid, decision text, review_note text, expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; item leadflow_private.onboarding_items; clean text; next_state text; event_kind text;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  perform leadflow_private.require_open_onboarding(request);
  select * into item from leadflow_private.onboarding_items i where i.request_id = target_request and i.id = target_item for update;
  if not found then raise exception 'Item not found in this request.' using errcode = 'P0002'; end if;
  if expected_revision is null or item.revision <> expected_revision then
    raise exception 'This item changed since you opened it, for example the client resubmitted it. Reload and review the latest version.' using errcode = '40001';
  end if;
  clean := leadflow_private.onboarding_clean_text(review_note, case decision when 'not_required' then 'Reason' else 'Comment' end, case decision when 'not_required' then 500 else 2000 end, false, false);
  if decision = 'accept' then
    if item.state = 'accepted' then raise exception 'This item is already accepted.' using errcode = '55000'; end if;
    if item.state = 'not_required' then raise exception 'Restore this item before accepting it.' using errcode = '55000'; end if;
    if item.state <> 'submitted' and clean = '' then
      raise exception 'Explain why you are accepting an item the client has not submitted, for example that access is already in place.' using errcode = '22023';
    end if;
    next_state := 'accepted'; event_kind := 'accepted';
  elsif decision = 'request_changes' then
    if item.state not in ('submitted','accepted') then raise exception 'Only submitted or accepted items can be sent back to the client.' using errcode = '55000'; end if;
    if clean = '' then raise exception 'Tell the client what to change.' using errcode = '22023'; end if;
    next_state := 'changes_requested'; event_kind := 'changes_requested';
  elsif decision = 'not_required' then
    if item.state = 'not_required' then raise exception 'This item is already marked not required.' using errcode = '55000'; end if;
    if clean = '' then raise exception 'Give a reason for marking this item not required.' using errcode = '22023'; end if;
    next_state := 'not_required'; event_kind := 'marked_not_required';
  elsif decision = 'restore' then
    if item.state <> 'not_required' then raise exception 'Only items marked not required can be restored.' using errcode = '55000'; end if;
    next_state := case when item.response is not null then 'submitted' else 'not_started' end; event_kind := 'restored';
  else
    raise exception 'Unknown review decision.' using errcode = '22023';
  end if;
  update leadflow_private.onboarding_items set state = next_state, revision = revision + 1, reviewed_at = now(), reviewed_by = leadflow_private.valid_actor(),
    client_feedback = case when decision in ('accept','request_changes') then clean when decision = 'not_required' then '' else client_feedback end,
    waive_reason = case when decision = 'not_required' then clean when decision = 'restore' then '' else waive_reason end
    where request_id = target_request and id = target_item returning * into item;
  perform leadflow_private.onboarding_event(target_request, target_item, 'member', leadflow_private.valid_actor(), event_kind,
    jsonb_strip_nulls(jsonb_build_object('comment', nullif(clean, ''), 'withoutSubmission', case when decision = 'accept' and item.submitted_at is null then true end, 'kind', item.kind)));
  perform leadflow_private.refresh_onboarding(target_request);
  return jsonb_build_object('state', item.state, 'revision', item.revision);
end $$;
create or replace function public.hand_off_onboarding(target_workspace uuid, target_request uuid, note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare request leadflow_private.onboarding_requests; existing leadflow_private.onboarding_handoffs; readiness jsonb;
begin
  perform leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  request := leadflow_private.lock_onboarding_request(target_workspace, target_request, null);
  select * into existing from leadflow_private.onboarding_handoffs h where h.request_id = target_request;
  if found then return jsonb_build_object('id', existing.id, 'handedOffAt', existing.handed_off_at, 'repeated', true); end if;
  if request.status <> 'active' then
    raise exception 'Only an open request can be handed off. This request is %.', case request.status when 'draft' then 'not open yet' else request.status end using errcode = '55000';
  end if;
  readiness := leadflow_private.onboarding_readiness(target_request);
  if not (readiness->>'requirementsMet')::boolean then
    raise exception 'Not ready: % required item(s) are still outstanding.', jsonb_array_length(readiness->'blockers') using errcode = '55000';
  end if;
  insert into leadflow_private.onboarding_handoffs(workspace_id, request_id, request_version, handed_off_by, note, summary)
    values (target_workspace, target_request, request.version + 1, leadflow_private.valid_actor(), leadflow_private.onboarding_clean_text(note, 'Handoff note', 2000, false, false),
      jsonb_build_object('title', request.title, 'clientName', request.client_name, 'serviceType', request.service_type, 'targetKickoffDate', request.target_kickoff_date,
        'leadId', request.lead_id, 'readiness', readiness,
        'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'required', i.required, 'state', i.state,
          'response', case when i.state = 'accepted' then i.response end, 'reason', nullif(i.waive_reason, '')) order by i.position)
          from leadflow_private.onboarding_items i where i.request_id = target_request), '[]')))
    returning * into existing;
  update leadflow_private.onboarding_requests set status = 'completed', completed_at = now(), version = version + 1, next_reminder_at = null where id = target_request;
  perform leadflow_private.cancel_onboarding_reminders(target_request, 'Stopped: handed off');
  perform leadflow_private.onboarding_event(target_request, null, 'member', leadflow_private.valid_actor(), 'handed_off', jsonb_build_object('handoffId', existing.id));
  return jsonb_build_object('id', existing.id, 'handedOffAt', existing.handed_off_at, 'repeated', false);
end $$;
create or replace function leadflow_private.portal_view(target_request uuid, link leadflow_private.onboarding_links) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('agencyName', w.name, 'title', r.title, 'clientName', r.client_name, 'status', r.status,
    'linkExpiresAt', link.expires_at,
    'instructions', case when r.status in ('active','paused','completed') then r.client_instructions else '' end,
    'dueDate', case when r.status in ('active','paused') then r.due_date end,
    'allAccepted', (leadflow_private.onboarding_readiness(r.id)->>'requirementsMet')::boolean and r.status in ('active','completed'),
    'confirmedAt', r.completed_at,
    'items', case when r.status in ('active','paused','completed') then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'section', i.section, 'title', i.title,
        'guidance', i.guidance, 'kind', i.kind, 'options', i.options, 'required', i.required, 'dueDate', coalesce(i.due_date, r.due_date), 'state', i.state,
        'value', coalesce(i.draft, i.response), 'hasDraft', i.draft is not null, 'submittedAt', i.submitted_at, 'revision', i.revision,
        'feedback', case when i.state in ('changes_requested','accepted') then nullif(i.client_feedback, '') end) order by i.position)
      from leadflow_private.onboarding_items i where i.request_id = r.id), '[]') else '[]'::jsonb end)
  from leadflow_private.onboarding_requests r join public.workspaces w on w.id = r.workspace_id where r.id = target_request
$$;
create or replace function public.portal_save_item(key_hash text, target_item uuid, response_value jsonb, submit boolean, expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link leadflow_private.onboarding_links; request leadflow_private.onboarding_requests; item leadflow_private.onboarding_items; clean jsonb; previous_state text;
begin
  link := leadflow_private.portal_link(key_hash);
  select * into request from leadflow_private.onboarding_requests r where r.id = link.request_id for update;
  if request.status <> 'active' then raise exception 'This onboarding request is not accepting responses right now.' using errcode = '55000'; end if;
  select * into item from leadflow_private.onboarding_items i where i.request_id = link.request_id and i.id = target_item for update;
  if not found then raise exception 'This item is no longer part of the request.' using errcode = '22023'; end if;
  if item.state in ('accepted','not_required') then raise exception 'This item has already been accepted or is no longer needed.' using errcode = '55000'; end if;
  clean := leadflow_private.onboarding_clean_response(item.kind, item.options, response_value, coalesce(submit, false));
  if coalesce(submit, false) and item.state = 'submitted' and item.response = clean and item.draft is null then
    return jsonb_build_object('state', item.state, 'revision', item.revision, 'unchanged', true);
  end if;
  if not coalesce(submit, false) and item.draft = clean then
    return jsonb_build_object('state', item.state, 'revision', item.revision, 'unchanged', true);
  end if;
  if expected_revision is null or item.revision <> expected_revision then
    raise exception 'This item was updated elsewhere. Reload the page to see the latest version.' using errcode = '40001';
  end if;
  previous_state := item.state;
  if coalesce(submit, false) then
    update leadflow_private.onboarding_items set response = clean, draft = null, state = 'submitted', submitted_at = now(), revision = revision + 1
      where request_id = link.request_id and id = target_item returning * into item;
    perform leadflow_private.onboarding_event(link.request_id, target_item, 'client', null, case previous_state when 'not_started' then 'submitted' else 'resubmitted' end, jsonb_build_object('kind', item.kind));
    perform leadflow_private.refresh_onboarding(link.request_id);
  else
    update leadflow_private.onboarding_items set draft = clean, revision = revision + 1 where request_id = link.request_id and id = target_item returning * into item;
  end if;
  update leadflow_private.onboarding_links set last_used_at = now() where id = link.id;
  return jsonb_build_object('state', item.state, 'revision', item.revision, 'unchanged', false);
end $$;

create or replace function public.save_workspace_for(target_workspace uuid, payload jsonb, expected_revision bigint, request_id uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare actor_role text; current_revision bigint; receipt public.workspace_requests; fingerprint text; kept jsonb;
begin
  actor_role := leadflow_private.require_role(target_workspace, array['owner','admin','member'], true);
  if request_id is null or expected_revision is null then raise exception 'Missing request identity or revision.'; end if;
  if payload is null or payload->>'version' is distinct from '1'
    or jsonb_typeof(payload->'leads') is distinct from 'array'
    or jsonb_typeof(payload->'tasks') is distinct from 'array'
    or jsonb_typeof(payload->'activities') is distinct from 'array' then raise exception 'Invalid workspace data.'; end if;
  if octet_length(payload::text) > 5000000 or jsonb_array_length(payload->'leads') > 5000
    or jsonb_array_length(payload->'tasks') > 10000 or jsonb_array_length(payload->'activities') > 20000 then raise exception 'Workspace is too large (5 MB maximum).'; end if;
  fingerprint := md5(payload::text || ':' || expected_revision::text);
  select revision into current_revision from public.workspaces where id = target_workspace;
  select * into receipt from public.workspace_requests r where r.workspace_id = target_workspace and r.request_id = save_workspace_for.request_id;
  if found then
    if receipt.payload_hash <> fingerprint then raise exception 'Request ID already used for different data.'; end if;
    return receipt.revision;
  end if;
  if current_revision <> expected_revision then raise exception 'Workspace changed in another session. Reload the workspace before trying again.' using errcode = '40001'; end if;
  if actor_role = 'member' then
    if exists ((select l.id from public.leads l where l.workspace_id = target_workspace) except (select x.id from jsonb_to_recordset(payload->'leads') as x(id text)))
      or exists ((select t.id from public.follow_up_tasks t where t.workspace_id = target_workspace) except (select x.id from jsonb_to_recordset(payload->'tasks') as x(id text))) then
      raise exception 'Only workspace owners and admins can remove leads or follow-ups.' using errcode = '42501';
    end if;
    if exists ((select a.id, a."leadId", a.text, a.at from public.activity_history a where a.workspace_id = target_workspace)
      except (select x.id, x."leadId", x.text, x.at from jsonb_to_recordset(payload->'activities') as x(id text, "leadId" text, text text, at timestamptz))) then
      raise exception 'Members can add to the activity history but not change or remove it.' using errcode = '42501';
    end if;
  end if;
  -- Assignees already on a task stay even if they left the workspace; any new assignment is checked by the trigger.
  select coalesce(jsonb_object_agg(t.id, t."assigneeId"), '{}') into kept from public.follow_up_tasks t where t.workspace_id = target_workspace and t."assigneeId" is not null;
  delete from public.leads where workspace_id = target_workspace;
  insert into public.leads(workspace_id, id, name, email, phone, company, service, source, message, status, "createdAt",
      website, industry, address, city, region, postcode, country)
    select target_workspace, x.id, x.name, x.email, x.phone, x.company, x.service, x.source, x.message, x.status, x."createdAt",
      coalesce(x.website, ''), coalesce(x.industry, ''), coalesce(x.address, ''), coalesce(x.city, ''), coalesce(x.region, ''), coalesce(x.postcode, ''), coalesce(x.country, '')
    from jsonb_to_recordset(payload->'leads') as x(id text, name text, email text, phone text, company text, service text, source text, message text, status text, "createdAt" timestamptz,
      website text, industry text, address text, city text, region text, postcode text, country text);
  perform set_config('leadflow.kept_assignees', kept::text, true);
  insert into public.follow_up_tasks(workspace_id, id, "leadId", due, notes, completed, "dealId", "contactId", "taskType", priority, cancelled, description, "assigneeId", "createdAt", "completedAt")
    select target_workspace, x.id, x."leadId", x.due, x.notes, x.completed, x."dealId", x."contactId", coalesce(x."taskType", 'follow_up'), coalesce(x.priority, 'medium'),
      coalesce(x.cancelled, false), coalesce(x.description, ''), x."assigneeId", x."createdAt", x."completedAt"
    from jsonb_to_recordset(payload->'tasks') as x(id text, "leadId" text, due date, notes text, completed boolean, "dealId" uuid, "contactId" uuid, "taskType" text, priority text,
      cancelled boolean, description text, "assigneeId" uuid, "createdAt" timestamptz, "completedAt" timestamptz);
  perform set_config('leadflow.kept_assignees', '', true);
  insert into public.activity_history(workspace_id, id, "leadId", text, at)
    select target_workspace, x.id, x."leadId", x.text, x.at
    from jsonb_to_recordset(payload->'activities') as x(id text, "leadId" text, text text, at timestamptz);
  delete from leadflow_private.lead_origins o where o.workspace_id = target_workspace
    and not exists (select 1 from public.leads l where l.workspace_id = target_workspace and l.id = o.lead_id);
  update public.workspaces set revision = revision + 1 where id = target_workspace returning revision into current_revision;
  insert into public.workspace_requests(workspace_id, request_id, payload_hash, revision, actor_id)
    values (target_workspace, request_id, fingerprint, current_revision, leadflow_private.valid_actor());
  return current_revision;
end $$;

create or replace function leadflow_private.check_follow_up_task() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new."dealId" is not null and not exists (select 1 from leadflow_private.deals d where d.workspace_id = new.workspace_id and d.id = new."dealId" and d.lead_id = new."leadId") then
    raise exception 'A follow-up’s deal must belong to the same lead.' using errcode = '22023';
  end if;
  if new."contactId" is not null and not exists (select 1 from leadflow_private.lead_contacts c where c.workspace_id = new.workspace_id and c.id = new."contactId" and c.lead_id = new."leadId") then
    raise exception 'A follow-up’s contact must belong to the same lead.' using errcode = '22023';
  end if;
  -- A new assignment must be a member. The snapshot save re-inserts every task, so it lists the assignees tasks already
  -- had (leadflow.kept_assignees); those stay even if the person has since left the workspace.
  if new."assigneeId" is not null
      and (tg_op = 'INSERT' or new."assigneeId" is distinct from old."assigneeId")
      and not exists (select 1 from public.workspace_memberships m where m.workspace_id = new.workspace_id and m.user_id = new."assigneeId")
      and coalesce(nullif(current_setting('leadflow.kept_assignees', true), ''), '{}')::jsonb ->> new.id is distinct from new."assigneeId"::text then
    raise exception 'Assign follow-ups to members of this workspace.' using errcode = '22023';
  end if;
  return new;
end $$;

-- 3. M10 functions, columns and tables.
drop function public.onboarding_item_history(uuid, uuid, uuid), public.save_onboarding_step(uuid, uuid, jsonb, integer), public.remove_onboarding_step(uuid, uuid, uuid, integer), public.set_onboarding_step_status(uuid, uuid, uuid, text, text, integer), public.clients_for(uuid, jsonb), public.client_index_for(uuid), public.client_dashboard_for(uuid, jsonb, date), public.client_detail(uuid, uuid), public.create_client(uuid, jsonb, uuid), public.convert_deal_to_client(uuid, uuid, jsonb, uuid), public.start_client_onboarding(uuid, uuid, jsonb, uuid), public.update_client(uuid, uuid, integer, jsonb), public.set_client_status(uuid, uuid, text, integer, text), public.save_client_contact(uuid, uuid, jsonb), public.delete_client_contact(uuid, uuid, uuid), public.save_client_service(uuid, uuid, jsonb), public.save_client_requirement(uuid, uuid, jsonb, integer, uuid), public.client_requirement_history(uuid, uuid), public.confirm_client_scope(uuid, uuid, jsonb), public.client_scope_history(uuid, uuid), public.save_client_welcome(uuid, uuid, text, text), public.mark_client_welcome_sent(uuid, uuid, text), public.add_client_note(uuid, uuid, text, uuid), public.client_timeline(uuid, uuid, jsonb, timestamptz, integer, text), public.client_completion_check(uuid, uuid), public.complete_client_onboarding(uuid, uuid, text, text), public.client_handoff_for(uuid, uuid), public.onboarding_stages_for(uuid), public.save_onboarding_stage(uuid, jsonb), public.reorder_onboarding_stages(uuid, jsonb), public.set_onboarding_stage_archived(uuid, uuid, boolean), public.onboarding_forms_for(uuid), public.onboarding_form_for(uuid, uuid), public.save_onboarding_form(uuid, jsonb, integer, uuid), public.duplicate_onboarding_form(uuid, uuid, uuid), public.set_onboarding_form_archived(uuid, uuid, boolean), public.assign_onboarding_form(uuid, uuid, uuid, text, integer), public.begin_client_document(uuid, uuid, jsonb, bigint), public.client_document_access(uuid, uuid), public.client_documents_for(uuid, uuid), public.update_client_document(uuid, uuid, jsonb), public.delete_client_document(uuid, uuid), public.finish_client_document(uuid, boolean, bigint, text), public.portal_begin_upload(text, uuid, jsonb, bigint), public.portal_document_access(text, uuid, text), public.portal_remove_upload(text, uuid), public.portal_acknowledge_scope(text, uuid);
drop function leadflow_private.ensure_onboarding_stages(uuid), leadflow_private.onboarding_stage_ref(uuid, text), leadflow_private.onboarding_clean_step(jsonb), leadflow_private.onboarding_clean_answer(leadflow_private.onboarding_items, jsonb, boolean), leadflow_private.onboarding_stage_progress(uuid), leadflow_private.client_event(uuid, text, text, jsonb, text, text, text), leadflow_private.lock_client(uuid, uuid, integer), leadflow_private.lock_active_client(uuid, uuid, integer), leadflow_private.client_onboarding_state(uuid), leadflow_private.complete_auto_steps(uuid, text, text), leadflow_private.onboarding_default_stage_key(text, text), leadflow_private.onboarding_starter_steps(), leadflow_private.sync_auto_steps(uuid), leadflow_private.clean_client_details(jsonb), leadflow_private.client_owner_ref(uuid, text), leadflow_private.clean_client_contact(jsonb), leadflow_private.clean_client_service(jsonb), leadflow_private.add_client_people(leadflow_private.clients, jsonb, jsonb, text, text), leadflow_private.client_summary_json(leadflow_private.clients), leadflow_private.client_completion_items(uuid), leadflow_private.document_type_allowed(text, text), leadflow_private.begin_document(uuid, uuid, uuid, uuid, jsonb, text, uuid, uuid, bigint), leadflow_private.document_json(leadflow_private.client_documents);
alter table public.follow_up_tasks drop constraint follow_up_tasks_owner, drop constraint follow_up_tasks_client, drop constraint follow_up_tasks_request, drop constraint follow_up_tasks_item,
  drop column "clientId", drop column "onboardingRequestId", drop column "onboardingItemId";
alter table public.follow_up_tasks alter column "leadId" set not null;
drop index if exists public.follow_up_tasks_client;
alter table public.follow_up_tasks drop constraint "follow_up_tasks_taskType_check";
alter table public.follow_up_tasks add constraint "follow_up_tasks_taskType_check" check ("taskType" in ('follow_up','call','email','whatsapp','meeting','proposal','proposal_review','internal','custom'));
alter table leadflow_private.deal_activities drop constraint deal_activities_kind_check;
alter table leadflow_private.deal_activities add constraint deal_activities_kind_check check (kind in ('deal_created','stage_changed','value_updated','details_updated','note','reply','call','proposal_sent',
  'meeting_scheduled','meeting_updated','meeting_completed','meeting_cancelled','meeting_no_show','won','lost','reopened','archived','restored','handoff_confirmed'));
drop table leadflow_private.client_documents, leadflow_private.onboarding_item_responses, leadflow_private.onboarding_steps, leadflow_private.onboarding_template_steps,
  leadflow_private.client_onboarding_completions, leadflow_private.client_activities, leadflow_private.client_scope_confirmations, leadflow_private.client_requirement_revisions,
  leadflow_private.client_requirements, leadflow_private.client_services, leadflow_private.client_contacts;
alter table leadflow_private.onboarding_items drop constraint onboarding_items_stage, drop column stage_id, drop column config, drop column form_name, drop column assignment_id;
alter table leadflow_private.onboarding_template_items drop constraint onboarding_template_items_stage, drop column stage_id, drop column config, drop column form_name;
drop table leadflow_private.onboarding_form_assignments, leadflow_private.onboarding_form_fields, leadflow_private.onboarding_forms;
alter table leadflow_private.onboarding_requests drop constraint onboarding_requests_client, drop column client_id;
drop table leadflow_private.clients, leadflow_private.onboarding_stages;
alter table leadflow_private.onboarding_items drop constraint onboarding_items_kind_check;
alter table leadflow_private.onboarding_items add constraint onboarding_items_kind_check check (kind in ('text','choice','links','access'));
alter table leadflow_private.onboarding_template_items drop constraint onboarding_template_items_kind_check;
alter table leadflow_private.onboarding_template_items add constraint onboarding_template_items_kind_check check (kind in ('text','choice','links','access'));
alter table leadflow_private.onboarding_templates drop constraint onboarding_templates_starter_key_check;
alter table leadflow_private.onboarding_templates add constraint onboarding_templates_starter_key_check check (starter_key in ('paid_ads','seo','social','email'));
drop function leadflow_private.is_onboarding_kind(text);
