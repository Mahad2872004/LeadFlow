export type IntegrationCategory = 'Website & forms' | 'Automation' | 'Developer' | 'Business tools'
export interface Integration { id:string; name:string; category:IntegrationCategory; description:string; mark:string; kind:'form'|'api'|'automation'|'email'|'planned' }
export const integrations:Integration[]=[
 {id:'hosted',name:'Hosted inquiry form',category:'Website & forms',description:'Share a dedicated page that sends inquiries straight to your workspace.',mark:'↗',kind:'form'},
 {id:'embed',name:'Embeddable website form',category:'Website & forms',description:'Bring the secure LeadFlow form to your own website with a simple embed.',mark:'</>',kind:'form'},
 {id:'wordpress',name:'WordPress',category:'Website & forms',description:'Add the inquiry form with a Custom HTML block or a page builder.',mark:'W',kind:'form'},
 {id:'custom',name:'Custom website',category:'Website & forms',description:'Installation examples for HTML and React websites.',mark:'{ }',kind:'form'},
 {id:'zapier',name:'Zapier',category:'Automation',description:'Send form responses or new spreadsheet rows through a webhook action.',mark:'✳',kind:'automation'},
 {id:'make',name:'Make',category:'Automation',description:'Map leads from your scenario into an authenticated HTTP request.',mark:'M',kind:'automation'},
 {id:'n8n',name:'n8n',category:'Automation',description:'Use an HTTP Request node with a workspace-scoped credential.',mark:'n8n',kind:'automation'},
 {id:'api',name:'Lead submission API',category:'Developer',description:'Request fields, authentication, responses, and retry behavior.',mark:'API',kind:'api'},
 {id:'webhook',name:'Inbound webhook',category:'Developer',description:'A private server-to-server route for incoming opportunities.',mark:'⇄',kind:'api'},
 {id:'examples',name:'Request examples',category:'Developer',description:'Copy JSON and a server-side cURL example to test your integration.',mark:'{}',kind:'api'},
 {id:'sheets',name:'Google Sheets',category:'Business tools',description:'Send new rows through Zapier, Make, or n8n. No native sync required.',mark:'▤',kind:'automation'},
 {id:'email',name:'Email notifications',category:'Business tools',description:'Use the existing Resend notification queue and inspect its status.',mark:'@',kind:'email'},
 {id:'crm',name:'CRM integrations',category:'Business tools',description:'Native CRM connections and two-way synchronization are planned.',mark:'◇',kind:'planned'},
]
export const categories:IntegrationCategory[]=['Website & forms','Automation','Developer','Business tools']
export const automationSteps:Record<string,string[]>={
 zapier:['Choose a trigger such as a new form response or a new Google Sheets row.','Create and persist a UUID for that source event before the HTTP step. Reuse it for retries; do not generate a new value on each retry.','Add Webhooks by Zapier → Custom Request. Choose POST and the endpoint shown below. Send a raw JSON body.','Add Content-Type: application/json and Authorization: Bearer YOUR_INTEGRATION_TOKEN. Keep the token in the platform’s restricted configuration; restrict editor access and logs.','Map fields into the nested inquiry object. Test one fictional event, verify its reference below, then enable the Zap. Webhooks availability depends on your Zapier plan.'],
 make:['Choose a trigger, for example a watched form response or new spreadsheet row.','Assign and persist a UUID for the source event before sending it, so retries keep the same requestId.','Add HTTP → Make a request. Set POST, the endpoint below, and a JSON body.','Use a protected credential/header for Authorization: Bearer YOUR_INTEGRATION_TOKEN. Set Content-Type: application/json and map the inquiry fields.','Run once, check the 200 response and reference in LeadFlow, then schedule the scenario. Stop or handle non-2xx responses rather than discarding them.'],
 n8n:['Choose a form, webhook, or spreadsheet trigger.','Persist a UUID with the event before the HTTP Request node. Reuse it when retrying the execution.','Add HTTP Request: POST to the endpoint below, with a JSON request body.','Use Generic Credential Type → Header Auth, with name Authorization and value Bearer YOUR_INTEGRATION_TOKEN. Do not place this token in frontend code.','Map the inquiry object, run a test execution, verify its reference below, then activate the workflow.'],
 sheets:['Choose Zapier, Make, or n8n to watch new rows in a Google Sheet. This is a documented import workflow, not native Google OAuth or two-way synchronization.','Add columns for requestId, name, email, service, message, and optionally phone and company. Store a new UUID in requestId once per row.','Use the selected platform’s HTTP/webhook action to POST the payload below. Keep the credential in the platform, never in a shared spreadsheet cell.','Map each row to inquiry fields and keep the same requestId if a row is retried. Editing a previously submitted row is not a lead-update operation.','Test a fictional row, verify the returned reference in this workspace, then enable the automation.'],
}
export const providerDocs:Record<string,string>={zapier:'https://help.zapier.com/hc/en-us/articles/8496326446989-Send-webhooks-in-Zaps',make:'https://apps.make.com/http',n8n:'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/'}
export function integrationUrls(origin:string,supabaseUrl:string|undefined){
 const base=import.meta.env.VITE_PUBLIC_FORM_ORIGIN||origin
 let form=''
 try{const parsed=new URL(base);if(parsed.protocol==='https:'||(parsed.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsed.hostname)))form=parsed.origin+'/inquiry'}catch{/* Configuration is displayed as missing, never guessed. */}
 let endpoint=''
 try{if(supabaseUrl){const parsed=new URL(supabaseUrl);if(parsed.protocol==='https:'||(parsed.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsed.hostname)))endpoint=parsed.origin+'/functions/v1/inbound-lead'}}catch{/* Invalid configuration. */}
 return {form,endpoint}
}
