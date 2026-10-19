# Superseded migrations — do not apply

`202610190001_workspace_foundation.sql` is an earlier, unfinished multi-workspace draft. It is kept unchanged for reference only. It was replaced by `../migrations/202610200001_multi_tenant_foundation.sql`. Applying it would:

- break the dashboard, integration overview and deployed Edge Functions, because it renames `owner_id` while their functions still use it;
- let anonymous callers run `receive_inquiry_for_workspace`, which writes leads into any workspace and queues email with caller-chosen sender, recipient and text.

If your project's migration history lists version `202610190001`, stop and read [docs/MULTI-TENANCY.md](../../docs/MULTI-TENANCY.md#pre-flight) before applying anything.
