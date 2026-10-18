import fs from 'node:fs';
import { loadEnv } from 'vite';
const env=loadEnv('production',process.cwd(),'VITE_');
const base=env.VITE_SUPABASE_URL,key=env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(!base||!key)throw new Error('Configure the Supabase public URL/key first.');
const checks=[
 ['Webhook rejects missing token','/functions/v1/inbound-lead',{}, {},[401]],
 ['Webhook rejects browser Origin','/functions/v1/inbound-lead',{Origin:'https://leadflow-tau-five.vercel.app'}, {},[403]],
 ['Retry worker rejects missing secret','/functions/v1/retry-notifications',{}, {},[401]],
 ['Public form rejects missing CAPTCHA','/functions/v1/submit-inquiry',{Origin:'https://leadflow-tau-five.vercel.app'}, {},[400]],
 ['Anonymous integration metadata denied','/rest/v1/rpc/integration_overview',{apikey:key}, {},[401,403]],
 ['Anonymous receipt verification denied','/rest/v1/rpc/verify_integration_receipt',{apikey:key},{submission_id:'11111111-1111-4111-8111-111111111111'},[401,403]],
];
const results=[];
for(const [name,path,headers,body,expected] of checks){
 try{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const raw=await response.text();let code='';try{code=JSON.parse(raw).code??''}catch{}
 const result={name,status:response.status,code,passed:expected.includes(response.status)};results.push(result);console.log(JSON.stringify(result));
 }catch(error){const result={name,passed:false,error:error.name};results.push(result);console.log(JSON.stringify(result));}
}
console.log('Negative probes only: no valid lead, email, credential, or external automation created. A denial does not verify successful intake.');
if(process.argv.includes('--save')){fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/live-integration-probes.json',JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));}
if(results.some(result=>!result.passed))process.exitCode=1;
