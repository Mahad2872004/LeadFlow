import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createInquiryHandler } from '../../supabase/functions/submit-inquiry/handler.ts'
import { createRetryHandler } from '../../supabase/functions/retry-notifications/handler.ts'
import type { Runtime } from '../../supabase/functions/_shared/runtime.ts'
export const actor='11111111-1111-4111-8111-111111111111'
export async function createHarness(){
 const db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select '${actor}'::uuid $$;
 create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
 insert into auth.users values('${actor}');`)
 for(const name of ['202610180001_m2.sql','202610180002_m3.sql'])await db.exec(readFileSync(`supabase/migrations/${name}`,'utf8'))
 const config:Record<string,string>={SUPABASE_URL:'http://127.0.0.1:54329',SUPABASE_SERVICE_ROLE_KEY:'test-server-key',WEBSITE_OWNER_ID:actor,WEBSITE_ID:'example-website',INQUIRY_ALLOWED_ORIGINS:'http://127.0.0.1:5175,http://127.0.0.1:4175',TURNSTILE_HOSTNAMES:'127.0.0.1',TURNSTILE_SECRET_KEY:'test-turnstile-secret',EMAIL_HASH_SECRET:'test-email-hash-secret-at-least-32-chars',RESEND_API_KEY:'test-resend-secret',NOTIFICATION_FROM:'LeadFlow <leads@example.com>',NOTIFICATION_TO:'business@example.com',NOTIFICATION_WORKER_SECRET:'test-worker-secret-at-least-32-characters'}
 const state={providerStatus:200,providerTimeout:false,captchaSuccess:true,captchaHost:'127.0.0.1',captchaAction:'inquiry',providerCalls:[] as {key:string;body:string}[],accepted:new Map<string,string>()}
 const runtime:Runtime={env:name=>config[name],fetch:async(input,init)=>{
   const url=String(input)
   if(url.includes('siteverify'))return Response.json({success:state.captchaSuccess,hostname:state.captchaHost,action:state.captchaAction})
   if(url==='https://api.resend.com/emails'){
     const headers=new Headers(init?.headers),key=headers.get('Idempotency-Key')!,body=String(init?.body)
     state.providerCalls.push({key,body})
     if(state.providerStatus!==200)return Response.json({message:'Simulated failure'},{status:state.providerStatus})
     if(state.accepted.has(key)&&state.accepted.get(key)!==body)return Response.json({error:'Different payload for idempotency key'},{status:409})
     state.accepted.set(key,body)
     if(state.providerTimeout)throw new Error('Simulated ambiguous network failure')
     return Response.json({id:`provider-${key}`})
   }
   const name=url.split('/').at(-1),args=JSON.parse(String(init?.body))
   const signatures:Record<string,string[]>={inquiry_rate_limit:['bucket_key'],receive_inquiry:['target_owner','website_id','submission_id','inquiry','email_hash','notification'],claim_notification:['submission_id'],finish_notification:['submission_id','lease','outcome','provider_reference','failure_code']}
   if(!name||!signatures[name])throw new Error('Unexpected test URL')
   const values=signatures[name].map(key=>typeof args[key]==='object'&&args[key]!==null?JSON.stringify(args[key]):args[key])
   try{const result=await db.query<{result:unknown}>(`select public.${name}(${values.map((_,index)=>`$${index+1}`).join(',')}) as result`,values);return name==='finish_notification'?new Response(null,{status:204}):Response.json(result.rows[0].result)}
   catch(error){return Response.json({code:(error as {code?:string}).code},{status:400})}
 }}
 return {db,config,state,runtime,handler:createInquiryHandler(runtime),worker:createRetryHandler(runtime)}
}
