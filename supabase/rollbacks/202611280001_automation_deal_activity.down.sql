-- Reverses 202611280001_automation_deal_activity.sql. Run it as one batch, then:
--   npx supabase migration repair --status reverted 202611280001
-- Workflows that use the "Proposal marked sent" or "Reply recorded" trigger, or wait for a reply, stop matching events:
-- archive them first. Runs already waiting for a reply then time out as configured.

drop trigger if exists automation_capture on leadflow_private.deal_activities;
drop function if exists leadflow_private.automation_capture_deal_activity();

-- As in 202611270002_automation.sql.
create or replace function leadflow_private.automation_trigger_list() returns jsonb language sql immutable set search_path = '' as $$
  select $json$[
  {"type":"lead.created","group":"Leads","label":"Lead created","description":"A lead is added by hand, from a website form, an API connection, discovery or an import.","subject":"lead","uses":[["lead","lead"]]},
  {"type":"lead.status_changed","group":"Leads","label":"Lead status changed","description":"A lead's status changes, for example to Qualified.","subject":"lead","uses":[["lead","lead"]],
    "extra":[{"path":"previousStatus","label":"Previous status","type":"enum","options":["New","Contacted","Qualified","Converted","Lost"]}]},
  {"type":"analysis.completed","group":"Leads","label":"Business report completed","description":"A business report finishes (fully or partly).","subject":"lead","uses":[["lead_ref","lead"],["analysis","analysis"]]},
  {"type":"analysis.failed","group":"Leads","label":"Business report failed","description":"A business report can't be completed.","subject":"lead","uses":[["lead_ref","lead"],["analysis","analysis"]]},
  {"type":"task.created","group":"Leads","label":"Follow-up task created","description":"A follow-up, onboarding or project task is created.","subject":"task","uses":[["task","task"]]},
  {"type":"task.completed","group":"Leads","label":"Task completed","description":"A task is marked complete.","subject":"task","uses":[["task","task"]]},
  {"type":"task.overdue","group":"Leads","label":"Task overdue","description":"Checked every hour: an open task's due date has passed. Fires once per task and due date.","subject":"task","scan":true,
    "uses":[["task","task"]],"extra":[{"path":"daysOverdue","label":"Days overdue","type":"number"}]},
  {"type":"contact.created","group":"Contacts & outreach","label":"Contact found or added","description":"A contact is added to a lead, by a person or a contact search.","subject":"lead","uses":[["lead_ref","lead"],["contact","contact"]]},
  {"type":"outreach.draft_created","group":"Contacts & outreach","label":"Outreach draft created","description":"An outreach draft is generated or written. Nothing is sent.","subject":"lead","uses":[["lead_ref","lead"],["draft","draft"]]},
  {"type":"outreach.marked_ready","group":"Contacts & outreach","label":"Outreach draft marked ready","description":"A person marks a draft ready to send.","subject":"lead","uses":[["lead_ref","lead"],["draft","draft"]]},
  {"type":"outreach.marked_sent","group":"Contacts & outreach","label":"Outreach marked as sent","description":"A person records that they sent a message themselves. LeadFlow sends nothing.","subject":"lead","uses":[["lead_ref","lead"],["draft","draft"]]},
  {"type":"deal.created","group":"Sales","label":"Deal created","description":"A deal is created in the sales pipeline.","subject":"deal","uses":[["deal","deal"]]},
  {"type":"deal.stage_changed","group":"Sales","label":"Deal stage changed","description":"A person moves a deal to another open stage, or reopens it.","subject":"deal","uses":[["deal","deal"]],
    "extra":[{"path":"previousStage","label":"Previous stage","type":"text"}]},
  {"type":"deal.won","group":"Sales","label":"Deal marked won","description":"A person marks a deal won.","subject":"deal","uses":[["deal","deal"]],"extra":[{"path":"wonValue","label":"Final value","type":"number"}]},
  {"type":"deal.lost","group":"Sales","label":"Deal marked lost","description":"A person marks a deal lost.","subject":"deal","uses":[["deal","deal"]],"extra":[{"path":"lostReason","label":"Lost reason","type":"text"}]},
  {"type":"deal.meeting_scheduled","group":"Sales","label":"Meeting scheduled","description":"A meeting is scheduled on a deal.","subject":"deal","uses":[["deal","deal"],["meeting","meeting"]]},
  {"type":"deal.close_approaching","group":"Sales","label":"Expected close date approaching","description":"Checked every hour: an open deal's expected close date is within the chosen number of days.","subject":"deal","scan":true,
    "uses":[["deal","deal"]],"extra":[{"path":"daysUntilClose","label":"Days until close","type":"number"}],"config":[{"key":"days","label":"Days ahead","type":"number","min":1,"max":60,"default":7}]},
  {"type":"client.created","group":"Clients & onboarding","label":"Client created","description":"A client is created, by hand or from a won deal.","subject":"client","uses":[["client","client"]]},
  {"type":"client.invited","group":"Clients & onboarding","label":"Client invited to the portal","description":"A member invites a client person to the client portal.","subject":"client","uses":[["client","client"],["invitation","invitation"]]},
  {"type":"client.activated","group":"Clients & onboarding","label":"Client activated portal access","description":"An invited client person sets up their portal account.","subject":"client","uses":[["client","client"],["invitation","access"]]},
  {"type":"onboarding.started","group":"Clients & onboarding","label":"Onboarding started","description":"An onboarding checklist is created.","subject":"onboarding","uses":[["client","client"],["onboarding","onboarding"]]},
  {"type":"onboarding.item_submitted","group":"Clients & onboarding","label":"Client submitted information","description":"A client submits an onboarding item for review.","subject":"onboarding","uses":[["client","client"],["onboarding","onboarding"],["item","item"]]},
  {"type":"scope.confirmed","group":"Clients & onboarding","label":"Scope confirmed","description":"A member confirms the client's scope. Automations never confirm scope.","subject":"client","uses":[["client","client"],["scope","scope"]]},
  {"type":"onboarding.completed","group":"Clients & onboarding","label":"Onboarding completed","description":"A member completes a client's onboarding.","subject":"client","uses":[["client","client"],["completion","completion"]],
    "extra":[{"path":"hasProject","label":"Already has a project from it","type":"boolean"}]},
  {"type":"project.created","group":"Projects","label":"Project created","description":"A project is created.","subject":"project","uses":[["project","project"]]},
  {"type":"project.status_changed","group":"Projects","label":"Project status changed","description":"A person changes a project's status (started, on hold, completed…).","subject":"project","uses":[["project","project"]],
    "extra":[{"path":"previousStatus","label":"Previous status","type":"enum","options":["planning","not_started","in_progress","on_hold","at_risk","completed","cancelled"]}]},
  {"type":"project.overdue","group":"Projects","label":"Project overdue","description":"Checked every hour: the target date passed and the project isn't completed or cancelled. Fires once per target date.","subject":"project","scan":true,
    "uses":[["project","project"]],"extra":[{"path":"daysOverdue","label":"Days overdue","type":"number"}]},
  {"type":"milestone.created","group":"Projects","label":"Milestone created","description":"A milestone is added to a project.","subject":"milestone","uses":[["project","project"],["milestone","milestone"]]},
  {"type":"milestone.completed","group":"Projects","label":"Milestone completed","description":"A milestone is marked completed.","subject":"milestone","uses":[["project","project"],["milestone","milestone"]]},
  {"type":"milestone.due_soon","group":"Projects","label":"Milestone deadline approaching","description":"Checked every hour: an open milestone is due within the chosen number of days. Fires once per milestone and due date.","subject":"milestone","scan":true,
    "uses":[["project","project"],["milestone","milestone"]],"extra":[{"path":"daysUntilDue","label":"Days until due","type":"number"}],"config":[{"key":"days","label":"Days ahead","type":"number","min":1,"max":60,"default":3}]},
  {"type":"milestone.overdue","group":"Projects","label":"Milestone overdue","description":"Checked every hour: an open milestone's due date passed. Fires once per milestone and due date.","subject":"milestone","scan":true,
    "uses":[["project","project"],["milestone","milestone"]],"extra":[{"path":"daysOverdue","label":"Days overdue","type":"number"}]},
  {"type":"deliverable.created","group":"Projects","label":"Deliverable created","description":"A deliverable is added to a project.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"]]},
  {"type":"deliverable.status_changed","group":"Projects","label":"Deliverable status changed","description":"A deliverable's internal delivery status changes, for example to Ready for client review.","subject":"deliverable",
    "uses":[["project","project"],["deliverable","deliverable"]],"extra":[{"path":"previousStatus","label":"Previous status","type":"enum","options":["not_started","in_progress","internal_review","ready_for_review","completed","blocked"]}]},
  {"type":"deliverable.shared","group":"Client collaboration","label":"Deliverable shared with the client","description":"A deliverable becomes visible on the client portal.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"]]},
  {"type":"review.requested","group":"Client collaboration","label":"Review requested","description":"A version is sent to the client for review (including revised versions).","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["review","review"]]},
  {"type":"feedback.submitted","group":"Client collaboration","label":"Client feedback submitted","description":"A client gives structured feedback on a deliverable.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["feedback","feedback"]]},
  {"type":"deliverable.changes_requested","group":"Client collaboration","label":"Client requested changes","description":"A client asks for changes to a version.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["decision","decision"]]},
  {"type":"deliverable.approved","group":"Client collaboration","label":"Deliverable approved","description":"A client approves a version.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["decision","decision"]]},
  {"type":"deliverable.rejected","group":"Client collaboration","label":"Deliverable rejected","description":"A client rejects a version.","subject":"deliverable","uses":[["project","project"],["deliverable","deliverable"],["decision","decision"]]},
  {"type":"comment.client_created","group":"Client collaboration","label":"Client commented","description":"A client writes in a project discussion.","subject":"project","uses":[["project","project"],["comment","comment"]]},
  {"type":"file.client_uploaded","group":"Client collaboration","label":"Client uploaded a file","description":"A client's portal upload finishes checking and becomes available.","subject":"client","uses":[["client","client"],["file","file"]],
    "extra":[{"path":"project.id","label":"Project","type":"ref","entity":"project"},{"path":"project.name","label":"Project name","type":"text"}]},
  {"type":"update.published","group":"Client collaboration","label":"Project update published","description":"A member publishes a client-visible project update.","subject":"project","uses":[["project","project"],["update","update"]]},
  {"type":"schedule.time","group":"Schedules & webhooks","label":"On a schedule","description":"Daily, weekly, monthly or once, at a time in the workspace's time zone.","subject":null,"scan":true,"uses":[["schedule","schedule"]]},
  {"type":"webhook.received","group":"Schedules & webhooks","label":"Signed webhook received","description":"An external system (Zapier, Make, n8n, your CRM) sends a signed request to this workflow's endpoint.","subject":null,
    "uses":[],"extra":[{"path":"webhook.eventId","label":"Sender's event ID","type":"text"}]}
  ]$json$::jsonb
$$;

create or replace function leadflow_private.automation_waitable() returns jsonb language sql immutable set search_path = '' as $$
  select $json$[
  {"event":"analysis.completed","label":"Business report completed","entity":"lead","outputs":[{"path":"received","label":"Report completed","type":"boolean"},
    {"path":"analysisId","label":"Business report","type":"ref","entity":"analysis"},{"path":"opportunityCount","label":"Opportunities found","type":"number"},
    {"path":"topOpportunity","label":"Top opportunity","type":"text"}]},
  {"event":"task.completed","label":"Task completed","entity":"task","outputs":[{"path":"received","label":"Task completed","type":"boolean"}]},
  {"event":"deal.stage_changed","label":"Deal stage changed","entity":"deal","outputs":[{"path":"received","label":"Stage changed","type":"boolean"},{"path":"stage","label":"New stage","type":"text"}]},
  {"event":"deal.won","label":"Deal marked won","entity":"deal","outputs":[{"path":"received","label":"Deal won","type":"boolean"}]},
  {"event":"onboarding.item_submitted","label":"Client submits onboarding information","entity":"client","outputs":[{"path":"received","label":"Information submitted","type":"boolean"},{"path":"item","label":"Submitted item","type":"text"}]},
  {"event":"onboarding.completed","label":"Onboarding completed","entity":"client","outputs":[{"path":"received","label":"Onboarding completed","type":"boolean"}]},
  {"event":"deliverable.approved","label":"Client approves the deliverable","entity":"deliverable","outputs":[{"path":"received","label":"Approved","type":"boolean"}]},
  {"event":"deliverable.changes_requested","label":"Client requests changes","entity":"deliverable","outputs":[{"path":"received","label":"Changes requested","type":"boolean"}]},
  {"event":"feedback.submitted","label":"Client gives feedback","entity":"deliverable","outputs":[{"path":"received","label":"Feedback given","type":"boolean"},{"path":"category","label":"Feedback category","type":"text"}]}
  ]$json$::jsonb
$$;

create or replace function leadflow_private.automation_wait_output(event_type text, data jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('received', true) || case event_type
    when 'analysis.completed' then jsonb_build_object('analysisId', data->'analysis'->'id', 'opportunityCount', data->'analysis'->'opportunityCount', 'topOpportunity', data->'analysis'->'topOpportunity')
    when 'deal.stage_changed' then jsonb_build_object('stage', data->'deal'->'stage')
    when 'onboarding.item_submitted' then jsonb_build_object('item', data->'item'->'title')
    when 'feedback.submitted' then jsonb_build_object('category', data->'feedback'->'category')
    else '{}'::jsonb end
$$;
