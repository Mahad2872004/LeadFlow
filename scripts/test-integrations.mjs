import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createHarness, actor } from '../tests/support/m3.ts'
import { createWebhookHandler } from '../supabase/functions/inbound-lead/handler.ts'
const h=await createHarness(), handler=createWebhookHandler(h.runtime)
const token='lf_'+randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex')
const credential=(await h.db.query("insert into leadflow_private.integration_keys(workspace_id,label,provider,token_hash,notification_from,notification_to) values($1,'Test Zapier','zapier',$2,'LeadFlow <notify@example.com>','owner@example.com') returning id",[actor,hash])).rows[0].id
const inquiry={name:'Integration Test',email:'integration@example.com',phone:'',company:'',service:'Other',message:'Fictional server test'}
const id=crypto.randomUUID()
function request(requestId=id,details=inquiry,key=token,origin=false){return new Request('https://example.test/inbound-lead',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,...(origin?{Origin:'https://bad.example'}:{})},body:JSON.stringify({requestId,inquiry:details})})}
assert.equal((await handler(request(id,inquiry,'bad'))).status,401)
assert.equal((await handler(request(id,inquiry,token,true))).status,403)
assert.equal((await handler(request())).status,200)
assert.equal((await handler(request())).status,200)
assert.equal((await h.db.query('select * from public.leads')).rows.length,1)
assert.equal((await h.db.query('select source from public.leads')).rows[0].source,'Other')
assert.equal(h.state.accepted.size,1)
assert.equal((await handler(request(id,{...inquiry,message:'different'}))).status,409)
assert.equal((await handler(request(crypto.randomUUID(),{...inquiry,email:'bad'}))).status,422)
const other='22222222-2222-4222-8222-222222222222'
await h.db.query('insert into auth.users(id) values($1)',[other])
await h.db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await h.db.exec('set role authenticated')
const info=(await h.db.query('select public.integration_overview() as info')).rows[0].info
assert.equal(info.credentials[0].label,'Test Zapier');assert.ok(info.credentials[0].lastUsedAt)
assert.equal(JSON.stringify(info).includes(hash),false);assert.equal(JSON.stringify(info).includes(token),false);assert.equal(JSON.stringify(info).includes('owner@example.com'),false)
assert.equal((await h.db.query('select public.verify_integration_receipt($1) as receipt',[id])).rows[0].receipt.channel,'Webhook')
await assert.rejects(()=>h.db.query('select * from leadflow_private.integration_keys'),/permission denied/)
await assert.rejects(()=>h.db.query('select public.authorize_integration($1)',[hash]),/permission denied/)
await assert.rejects(()=>h.db.query("select public.receive_webhook($1,$2,'{}','hash')",[hash,id]),/permission denied/)
await h.db.query("select set_config('request.jwt.claim.sub',$1,false)",[other])
assert.deepEqual((await h.db.query('select public.integration_overview() as info')).rows[0].info.credentials,[])
await assert.rejects(()=>h.db.query('select public.verify_integration_receipt($1)',[id]),/No matching inquiry/)
await h.db.query('select public.revoke_integration($1)',[credential]);await h.db.exec('reset role')
assert.equal((await h.db.query('select revoked_at from leadflow_private.integration_keys')).rows[0].revoked_at,null)
await h.db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await h.db.exec('set role authenticated')
await h.db.query('select public.revoke_integration($1)',[credential]);await h.db.exec('reset role')
assert.equal((await handler(request())).status,401)
// Rotation preserves the integration ID and duplicate receipts, but requires a fresh verification.
const rotated='lf_'+randomBytes(32).toString('hex'),rotatedHash=createHash('sha256').update(rotated).digest('hex')
await h.db.query('update leadflow_private.integration_keys set token_hash=$1,revoked_at=null,last_used_at=null where id=$2',[rotatedHash,credential])
assert.equal((await handler(request())).status,401)
assert.equal((await handler(request(id,inquiry,rotated))).status,200)
assert.equal((await h.db.query('select * from public.leads')).rows.length,1)
// Workspace revision conflict protection still applies.
await assert.rejects(()=>h.db.query('select public.save_workspace($1,0,$2)',[JSON.stringify({version:1,leads:[],tasks:[],activities:[]}),crypto.randomUUID()]),/another session/)
h.state.providerStatus=500
assert.equal((await handler(request(crypto.randomUUID(),{...inquiry,email:'failure@example.com'},rotated))).status,200)
assert.equal((await h.db.query("select * from leadflow_private.notification_outbox where status='pending'")).rows.length,1)
await h.db.exec('set role anon')
for(const sql of ['select public.integration_overview()',`select public.verify_integration_receipt('${id}')`,`select public.revoke_integration('${credential}')`])await assert.rejects(()=>h.db.query(sql),/permission denied/)
await h.db.exec('reset role')
// A second workspace's token chooses its own destination and notification recipient.
const otherToken='lf_'+randomBytes(32).toString('hex'),otherHash=createHash('sha256').update(otherToken).digest('hex')
await h.db.query("insert into leadflow_private.integration_keys(workspace_id,label,provider,token_hash,notification_from,notification_to) values($1,'Other workflow','webhook',$2,'Other <other@example.com>','other-owner@example.com')",[other,otherHash])
const otherId=crypto.randomUUID()
assert.equal((await handler(request(otherId,inquiry,otherToken))).status,200)
assert.equal((await h.db.query('select workspace_id from public.leads where id=$1',[otherId])).rows[0].workspace_id,other)
const email=(await h.db.query('select email from leadflow_private.notification_outbox where request_id=$1',[otherId])).rows[0].email
assert.deepEqual(email.to,['other-owner@example.com']);assert.equal(email.from,'Other <other@example.com>')
assert.equal((await handler(request(id,inquiry,otherToken))).status,409)
// Enforce bounded bodies, email quota, workspace quota, and attempt throttling.
assert.equal((await handler(request(crypto.randomUUID(),{...inquiry,message:'x'.repeat(17000)},rotated))).status,400)
for(let i=0;i<4;i++)assert.equal((await handler(request(crypto.randomUUID(),inquiry,rotated))).status,200)
assert.equal((await handler(request(crypto.randomUUID(),inquiry,rotated))).status,429)
await h.db.query("insert into leadflow_private.inquiries(request_id,workspace_id,website,payload_hash,email_hash) select gen_random_uuid(),$1,'quota-test','test','test' from generate_series(1,50-(select count(*)::int from leadflow_private.inquiries where workspace_id=$1))",[actor])
assert.equal((await handler(request(crypto.randomUUID(),{...inquiry,email:'new@example.com'},rotated))).status,429)
assert.equal((await handler(request(id,inquiry,rotated))).status,200)
await h.db.query("insert into leadflow_private.request_limits(bucket,minute,hits) values($1,date_trunc('minute',now()),60) on conflict(bucket,minute) do update set hits=60",['api-'+rotatedHash])
assert.equal((await handler(request(id,inquiry,rotated))).status,429)
await h.db.close()
console.log('PASS Integrations: webhook handlers + SQL, scoped authorization, redacted metadata, receipt verification, owner isolation, revocation/rotation, idempotency, conflict protection, validation, and email failure preservation. No external platform connected.')
